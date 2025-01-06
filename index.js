var express = require("express");
const { WebSocket } = require("ws");
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
  ws.on("message", function incoming(message) {
    const js = JSON.parse(message);
    if (js.msg_type == "data:subscribe_oauth" || js.msg_type == "data:subscribe_all") {
      console.log("Subscribe from: %s", js.tag);
      tags[js.tag] = ws;
      if (js.msg_type == "data:subscribe_all") {
        tagsRaw[js.tag] = true;
      }

      ws.send(
        JSON.stringify({
          msg_type: "control:hello",
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
        console.log("Close: " + keys[i]);
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
 * Transform a message from Tesla Telemetry to a websocket streaming message
 * @param {*} data
 * @returns
 */
function transformMessage(data) {
  try {
    const jsonData = JSON.parse(data);
    if (jsonData.vin in tagsRaw) {
      return {tag:jsonData.vin, raw: jsonData};
    }
    console.log("Reveived POST from pubsub:", JSON.stringify(jsonData,null, "  "));
    let associativeArray = {};

    // Extract data from JSON event
    jsonData.data.forEach((item) => {
      if (item.value.locationValue) {
        associativeArray["Latitude"] = item.value.locationValue.latitude;
        associativeArray["Longitude"] = item.value.locationValue.longitude;
      } else {
        associativeArray[item.key] = item.value.stringValue;
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
    let power = 0;
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
      console.log(JSON.stringify(msg));
      if ('raw' in msg) {
        tags[msg.tag].send(JSON.stringify(msg.raw));
      } else {
        tags[msg.tag].send(JSON.stringify(msg));
      }
    }
  } catch (e) {
    console.error(e);
  }
}

app.listen(8081, () => console.log("listening on http://localhost:8081/"));
