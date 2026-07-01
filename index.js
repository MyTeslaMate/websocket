var express = require("express");
const { WebSocket } = require("ws");
const https = require("https");
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

// When false (default), a token that fails validation on data:subscribe_oauth
// is still allowed through (migration grace period) so clients that authenticate
// the old way keep streaming. Set ENFORCE_TOKEN=true to reject invalid tokens.
const ENFORCE_TOKEN = process.env.ENFORCE_TOKEN === "true";

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

app.post("/", (req, res) => {
  let buff = new Buffer.from(req.body.message.data, "base64");
  let data = buff.toString("ascii");
  let message = transformMessage(data);
  if (message) {
    broadcastMessage(message);
  }
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
function transformMessage(data) {
  try {
    const jsonData = JSON.parse(data);
    //console.log("Reveived POST from pubsub:", JSON.stringify(jsonData,null, "  "));
    if (jsonData.vin in tagsRaw) {
      return {tag:jsonData.vin, raw: jsonData};
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
    associativeArray = lastValues[jsonData.vin];

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

    //console.log(associativeArray);
    let r = {
      msg_type: "data:update",
      tag: jsonData.vin,
      value: [
        new Date(jsonData.createdAt).getTime(),
        speed, // speed
        associativeArray["Odometer"], // odometer
        Object.prototype.hasOwnProperty.call(associativeArray, "Soc")
          ? parseInt(associativeArray["Soc"])
          : "", // soc
        "", // elevation is computed next
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

    /*if (associativeArray["Latitude"] && associativeArray["Longitude"]) {
      const url =
        "https://api.open-meteo.com/v1/elevation?latitude=" +
        associativeArray["Latitude"] +
        "&longitude=" +
        associativeArray["Longitude"];
      try {
        const res = request("GET", url);
        const data = JSON.parse(res.getBody("utf8"));
        r.value = r.value.replace("ELEVATION", parseInt(data["elevation"][0]));
      } catch (error) {
        console.error("Error getting elevation", error);
        r.value = r.value.replace("ELEVATION", "");
      }
    } else {
      r.value = r.value.replace("ELEVATION", "");
    }*/

    if (associativeArray["Latitude"] && associativeArray["Longitude"] && associativeArray["Gear"] && associativeArray["Gear"] != "") {
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
