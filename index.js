var express = require("express");
const { WebSocket } = require("ws");
const https = require("https");
const http = require("http");
var app = express();
require("express-ws")(app);
app.use(express.json());

//const request = require("sync-request");

// Save ws associated with each tag
let tags = {};
// Save last tag event time
let lastTags = {};
// Keep last values for each VIN because only changed datas are send since 08/2024
let lastValues = {};
// Reference tags for raw data
let tagsRaw = {};
// Reference valid tokens
let invalidTokens = {};

// Per-VIN FIFO. transformMessage awaits a variable-latency elevation lookup, and
// POSTs are handled concurrently, so without serialisation two frames of the same
// VIN would interleave around that await — racing on the shared lastValues[vin]
// object and forwarding out of order. That drew "GPS jumps back and forth"
// artifacts in drives (a frame's createdAt stamped onto a neighbour's coordinate).
// Each VIN's frames now run strictly in arrival order; different VINs stay
// concurrent. NB: correct only while this forwarder runs as a single replica —
// scaling it out needs sticky VIN->replica routing (or a shared ordering store).
const vinQueues = new Map();
function enqueueByVin(vin, task) {
  const prev = vinQueues.get(vin) || Promise.resolve();
  const next = prev.then(task, task);
  vinQueues.set(vin, next);
  // Drop the tail once settled so the Map can't grow unbounded.
  next.finally(() => {
    if (vinQueues.get(vin) === next) vinQueues.delete(vin);
  });
  return next;
}

// Last createdAt (ms) actually forwarded per VIN. The telemetry pullers run as
// 6-15 competing PubSub consumers with no message ordering, so a single VIN's
// consecutive frames can reach us out of createdAt order. We forward only
// non-decreasing timestamps so TeslaMate never inserts a position behind an
// earlier one — which is what draws the backtracking line on the map.
let lastForwardedTs = {};

// When false (default), a token that fails validation on data:subscribe_oauth
// is still allowed through (migration grace period) so clients that authenticate
// the old way keep streaming. Set ENFORCE_TOKEN=true to reject invalid tokens.
const ENFORCE_TOKEN = process.env.ENFORCE_TOKEN === "true";

// Elevation enrichment via a self-hosted Open Topo Data instance.
// Fleet Telemetry carries no elevation, so without this the `elevation` slot of
// every frame is empty and TeslaMate's SRTM backfill never fills it (it treats
// streamed drives as already-elevated). When OPENTOPODATA_URL is set we look up
// elevation from lat/lng and fill the slot ourselves. The lookup is async (it
// must never block the event loop — a sync HTTP call here would freeze every
// vehicle and crashloop the pod) and bounded by a short timeout; on
// miss/timeout/error we forward an empty elevation, exactly like before.
const OPENTOPODATA_URL = process.env.OPENTOPODATA_URL || "";
const OPENTOPODATA_DATASET = process.env.OPENTOPODATA_DATASET || "copernicus90";
const OPENTOPODATA_TIMEOUT_MS = parseInt(process.env.OPENTOPODATA_TIMEOUT_MS || "2000", 10);
const ELEVATION_CACHE_MAX = parseInt(process.env.OPENTOPODATA_CACHE_MAX || "50000", 10);
// Bound concurrency to the single OTD instance: without this the forwarder
// fires an unbounded burst of lookups that overwhelms OTD (queries time out and
// its liveness probe fails, restarting it). keepAlive reuses sockets; excess
// requests queue in the agent (their per-request timeout only starts once a
// socket is assigned, so queuing never causes a premature timeout).
const OPENTOPODATA_MAX_SOCKETS = parseInt(process.env.OPENTOPODATA_MAX_SOCKETS || "3", 10);
const otdAgents = {
  "http:": new http.Agent({ keepAlive: true, maxSockets: OPENTOPODATA_MAX_SOCKETS }),
  "https:": new https.Agent({ keepAlive: true, maxSockets: OPENTOPODATA_MAX_SOCKETS }),
};

// Tiny LRU: a Map preserves insertion order, so deleting+reinserting on a hit
// and evicting the oldest key keeps the hottest coordinates cached. Keyed on
// 4-decimal lat/lng (~11 m) so stationary/charging frames never re-query.
const elevationCache = new Map();

function elevationCacheGet(key) {
  if (!elevationCache.has(key)) return undefined;
  const val = elevationCache.get(key);
  elevationCache.delete(key);
  elevationCache.set(key, val);
  return val;
}

function elevationCacheSet(key, val) {
  if (elevationCache.has(key)) elevationCache.delete(key);
  elevationCache.set(key, val);
  if (elevationCache.size > ELEVATION_CACHE_MAX) {
    elevationCache.delete(elevationCache.keys().next().value);
  }
}

/**
 * Look up elevation (metres) for a coordinate from Open Topo Data.
 * @returns {Promise<number|string>} rounded metres, or "" when disabled/unknown.
 */
async function getElevation(lat, lng) {
  if (
    !OPENTOPODATA_URL ||
    lat === undefined ||
    lat === "" ||
    lng === undefined ||
    lng === ""
  ) {
    return "";
  }
  const key = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
  const cached = elevationCacheGet(key);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const url =
      `${OPENTOPODATA_URL.replace(/\/$/, "")}/v1/${OPENTOPODATA_DATASET}` +
      `?locations=${lat},${lng}`;
    // Use the http/https module (not global fetch): the Bitnami node runtime
    // this runs on has no fetch/AbortSignal.timeout.
    const body = await fetchJson(url, OPENTOPODATA_TIMEOUT_MS);
    const elevation =
      body && body.results && body.results[0] && body.results[0].elevation;
    if (elevation === null || elevation === undefined) {
      return "";
    }
    const rounded = Math.round(elevation);
    // Only cache successful lookups, so a transient error never poisons a coord.
    elevationCacheSet(key, rounded);
    return rounded;
  } catch (error) {
    console.error("Elevation lookup failed:", String(error));
    return "";
  }
}

/**
 * GET a JSON URL with a hard timeout, using the built-in http/https module.
 * @returns {Promise<object>} parsed JSON body (rejects on non-200/timeout/parse)
 */
function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = url.indexOf("https:") === 0;
    const mod = isHttps ? https : http;
    const agent = otdAgents[isHttps ? "https:" : "http:"];
    const req = mod.get(url, { agent }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/send", (req, res) => {
  if (req.query.msg && req.query.tag) {
    let message = JSON.parse(
      '{"msg_type":"data:update","tag":"' +
        req.query.tag +
        '","value":"' +
        Date.now() +
        "," +
        req.query.msg +
        '"}',
    );
    broadcastMessage(message);
  }
  if (req.query.offline && req.query.tag) {
    let message = JSON.parse(
      '{"msg_type": "data:error", "tag": "' +
        req.query.tag +
        '", "error_type": "vehicle_error", "value": "Vehicle is offline"}',
    );
    broadcastMessage(message);
  }
  if (req.query.disconnect && req.query.tag) {
    let message = JSON.parse(
      '{"msg_type": "data:error", "tag": "' +
        req.query.tag +
        '", "error_type": "vehicle_disconnected"}',
    );
    broadcastMessage(message);
  }
  if (req.query.kick && req.query.tag) {
    if (tags[req.query.tag]) {
      tags[req.query.tag].close();
    }
  }
  res.status(200).json({ status: "ok" });
});

app.post("/", async (req, res) => {
  let data;
  let vin;
  try {
    const buff = new Buffer.from(req.body.message.data, "base64");
    data = buff.toString("ascii");
    vin = JSON.parse(data).vin;
  } catch (e) {
    console.error("Bad POST body:", String(e));
    return res.status(200).json({ status: "ok" });
  }
  // Serialise per VIN so frames of one vehicle transform+forward in arrival order.
  await enqueueByVin(vin, async () => {
    const message = await transformMessage(data);
    if (message) {
      broadcastMessage(message);
    }
  });
  res.status(200).json({ status: "ok" });
});

app.ws("/streaming/", (ws /*, req*/) => {
  /** Say hello to TeslaMate */
  const interval_id = setInterval(function () {
    ws.send(
      JSON.stringify({
        msg_type: "control:hello",
        connection_timeout: 30000,
      }),
    );
  }, 10000);

  /** Subscribe to vehicle streaming data */
  ws.on("message", async function incoming(message) {
    const js = JSON.parse(message);
    let msg = "control:hello";
    if (js.msg_type == "data:subscribe_oauth" || js.msg_type == "data:subscribe_all") {
      console.log("Subscribe from %s %s at %s", js.msg_type, js.tag, new Date().toISOString());
      tags[js.tag] = ws;

      // Reject the connection with an error detail.
      const reject = (detail) => {
        ws.send(
          JSON.stringify({
            msg_type: "error",
            error_detail: detail,
            connection_timeout: 30000,
          }),
        );
        ws.close();
      };

      // Validation is async (non-blocking): a slow API call must never freeze
      // the event loop, otherwise the liveness probe times out and the pod
      // crashloops. This runs on every subscribe, including subscribe_oauth.
      const err = await validateToken(js.tag, js.token);

      if (js.msg_type == "data:subscribe_all") {
        // Raw passthrough mode: a valid token is mandatory.
        if (err) {
          reject(err);
          return;
        }
        tagsRaw[js.tag] = true;
        msg = "control:hello:" + js.tag;
      } else if (err) {
        // data:subscribe_oauth (column format).
        if (ENFORCE_TOKEN) {
          reject(err);
          return;
        }
        // Migration grace period: token not (yet) valid, but keep the
        // connection alive so clients authenticating the old way keep streaming.
        console.warn(
          "subscribe_oauth: token not validated (%s) for tag %s — allowing during migration",
          err,
          js.tag,
        );
      }

      ws.send(
        JSON.stringify({
          msg_type: msg,
          connection_timeout: 30000,
        }),
      );
    }
  });

  /** Delete connection when closed */
  ws.once("close", function close() {
    console.log("Close connection");
    clearInterval(interval_id);
    let keys = Object.keys(tags);
    for (let i = 0; i < keys.length; i++) {
      if (this == tags[keys[i]]) {
        console.log("Close: " + keys[i] + " at " + new Date().toISOString());
        delete tags[keys[i]];
        delete lastTags[keys[i]];
        delete tagsRaw[keys[i]];
      }
    }
  });
});

/*setInterval(function () {
  for (let key in tags) {
    // check last event
    if (lastTags[key]) {
      if (tags[key]) {
        if (lastTags[key] < new Date().getTime() - 3 * 61000) {
          tags[key].close();
        }
      }
    }
  }
}, 60000);*/

/**
 * Perform an async HTTPS GET.
 * @param {string} url
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      })
      .on("error", reject);
  });
}

/**
 * Validate a streaming token for a given tag (vehicle id) against the fleet API.
 * Async so the blocking sync HTTP call no longer freezes the event loop.
 * @param {string} tag vehicle id
 * @param {string} token token sent in the subscribe message
 * @returns {Promise<string|null>} an error message, or null when the token is valid
 */
async function validateToken(tag, token) {
  try {
    if (!token || token.trim() === "") {
      return "Token is missing or empty";
    }
    if (invalidTokens[tag + token]) {
      return "Token invalid (already tried)";
    }
    const response = await httpGet(
      `https://api.myteslamate.com/api/1/vehicles/${tag}/fleet_telemetry_config?token=${token}`,
    );
    if (response.statusCode == 401) {
      invalidTokens[tag + token] = true;
      return response.body;
    }
    if (response.statusCode == 200) {
      const apiResponse = JSON.parse(response.body);
      if (!apiResponse.response?.synced) {
        return "Fleet telemetry is not synced";
      }
      if (!apiResponse.response?.config) {
        return "No telemetry configuration available";
      }
    }
    return null;
  } catch (error) {
    console.error("Error during API call:", error);
    return String(error);
  }
}

/**
 * Transform a message from Tesla Telemetry to a websocket streaming message
 * @param {*} data
 * @returns
 */
async function transformMessage(data) {
  try {
    const jsonData = JSON.parse(data);
    //console.log("Reveived POST from pubsub:", JSON.stringify(jsonData,null, "  "));
    if (jsonData.vin in tagsRaw) {
      return {tag:jsonData.vin, raw: jsonData};
    }
    const vin = jsonData.vin;
    const createdAtMs = new Date(jsonData.createdAt).getTime();

    // Monotonic guard: drop a frame older than the last one we forwarded for this
    // VIN. Competing PubSub consumers deliver a VIN's frames out of createdAt
    // order; letting an older frame through would regress lastValues (and the
    // forwarded position) behind a newer one, redrawing the backtrack. Equal
    // timestamps pass (harmless duplicates). Skipped when createdAt is unparseable.
    if (
      Number.isFinite(createdAtMs) &&
      lastForwardedTs[vin] !== undefined &&
      createdAtMs < lastForwardedTs[vin]
    ) {
      console.log(
        "skip out-of-order frame vin=%s createdAt=%s < last=%s",
        vin,
        jsonData.createdAt,
        new Date(lastForwardedTs[vin]).toISOString(),
      );
      return;
    }

    let associativeArray = {};

    // Extract data from JSON event
    jsonData.data.forEach((item) => {
      if (item.value.locationValue) {
        associativeArray["Latitude"] = item.value.locationValue.latitude;
        associativeArray["Longitude"] = item.value.locationValue.longitude;
      } else {

        if (item.value.shiftStateValue) {
          associativeArray[item.key] = item.value.shiftStateValue.replace("ShiftState", "");
        } else if (item.value.doubleValue) {
          associativeArray[item.key] = item.value.doubleValue;
        } else if (item.value.intValue) {
          associativeArray[item.key] = item.value.intValue;
        } else {
          associativeArray[item.key] = item.value.stringValue;
        }
      }
    });

    // Save given values in lastValues
    if (!lastValues[jsonData.vin]) {
      lastValues[jsonData.vin] = {};
    }
    lastValues[jsonData.vin] = {
      ...lastValues[jsonData.vin],
      ...associativeArray,
    };
    // Build the outgoing message from a private snapshot, NOT the shared
    // lastValues object: nothing processed later may mutate the values this
    // message forwards while it is suspended on the elevation await below.
    associativeArray = { ...lastValues[jsonData.vin] };

    /** Prepare message for TeslaMate */
    // @TODO: wait the real value from https://github.com/teslamotors/fleet-telemetry/issues/170#issuecomment-2141034274)
    // In the meantime just return 0
    let power = Object.prototype.hasOwnProperty.call(associativeArray, "Power")
          ? parseInt(associativeArray["Power"])
          : 0;
    //let isCharging = false;

    let chargingPower = parseInt(associativeArray["DCChargingPower"]);
    if (chargingPower > 0) {
      power = chargingPower;
      //isCharging = true;
    }
    chargingPower = parseInt(associativeArray["ACChargingPower"]);
    if (chargingPower > 0) {
      power = chargingPower;
      //isCharging = true;
    }

    let speed = isNaN(parseInt(associativeArray["VehicleSpeed"]))
      ? ""
      : parseInt(associativeArray["VehicleSpeed"]);

    // Fill the elevation slot from Open Topo Data (no-op returning "" unless
    // OPENTOPODATA_URL is set). Awaiting the local, timeout-bounded lookup adds
    // at most a few ms per frame and Location only streams every ~25 s.
    const elevation = await getElevation(
      associativeArray["Latitude"],
      associativeArray["Longitude"],
    );

    //console.log(associativeArray);
    let r = {
      msg_type: "data:update",
      tag: jsonData.vin,
      value: [
        createdAtMs,
        speed, // speed
        associativeArray["Odometer"], // odometer
        Object.prototype.hasOwnProperty.call(associativeArray, "Soc")
          ? parseInt(associativeArray["Soc"])
          : "", // soc
        elevation, // elevation (Open Topo Data, "" when disabled/unknown)
        associativeArray["GpsHeading"] ?? "", // est_heading (TODO: is this the good field?)
        associativeArray["Latitude"], // est_lat
        associativeArray["Longitude"], // est_lng
        power, // power
        associativeArray["Gear"] ?? "", // shift_state
        associativeArray["RatedRange"], // range
        associativeArray["EstBatteryRange"], // est_range
        associativeArray["GpsHeading"] ?? "", // heading
      ].join(","),
    };

    lastTags[jsonData.vin] = new Date().getTime();

    if (associativeArray["Latitude"] && associativeArray["Longitude"] && associativeArray["Gear"] && associativeArray["Gear"] != "") {
      // Record the floor only for frames we actually forward, and only when the
      // timestamp is usable, so the monotonic guard above stays consistent.
      if (Number.isFinite(createdAtMs)) {
        lastForwardedTs[vin] = createdAtMs;
      }
      return r;
    } else {
      //console.error("no gps data");
      //console.log(JSON.stringify(r));
    }
  } catch (e) {
    console.error(e);
  }
}

/**
 * Forward a message from Tesla Telemetry to the websocket streaming client(s)
 * @param {*} message
 */
function broadcastMessage(msg) {
  try {
    if (msg && msg.tag in tags && tags[msg.tag].readyState === WebSocket.OPEN) {
      //console.log("Send to client " + msg.tag);
      if ('raw' in msg) {
        console.log(JSON.stringify(msg.raw));
        tags[msg.tag].send(JSON.stringify(msg.raw));
      } else {
        console.log(JSON.stringify(msg));
        tags[msg.tag].send(JSON.stringify(msg));
      }
    }
  } catch (e) {
    console.error(e);
  }
}

app.listen(8081, () => console.log("listening on http://localhost:8081/"));
