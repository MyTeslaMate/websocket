var express = require("express");
const { WebSocket } = require("ws");
var app = express();
require("express-ws")(app);
app.use(express.json());

// Save ws associated with each tag
let tags = {};

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
  broadcastMessage(message);
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
    if (js.msg_type == "data:subscribe_oauth") {
      console.log("Subscribe from: %s", js.tag);
      tags[js.tag] = ws;

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
      }
    }
  });
});

/**
 * Transform a message from Tesla Telemetry to a websocket streaming message
 * @param {*} data
 * @returns
 */
function transformMessage(data) {
  try {
    const jsonData = JSON.parse(data);
    //console.log(jsonData);
    const associativeArray = {};

    // Extract data from JSON event
    jsonData.data.forEach((item) => {
      if (item.value.locationValue) {
        associativeArray["Latitude"] = item.value.locationValue.latitude;
        associativeArray["Longitude"] = item.value.locationValue.longitude;
      } else {
        associativeArray[item.key] = item.value.stringValue;
      }
    });

    /** Prepare message for TeslaMate */
    let power = "";
    let isCharging = false;
    if (associativeArray["Gear"]) {
      power = 0; // TODO: wait the real value from https://github.com/teslamotors/fleet-telemetry/issues/170#issuecomment-2141034274)
    }
    let charginPower = parseInt(associativeArray["DCChargingPower"]);
    if (charginPower < 0) {
      power = charginPower;
      isCharging = true;
    }
    charginPower = parseInt(associativeArray["ACChargingPower"]);
    if (charginPower < 0) {
      power = charginPower;
      isCharging = true;
    }

    const r = {
      msg_type: "data:update",
      tag: jsonData.vin,
      value: [
        new Date(jsonData.createdAt).getTime(),
        isNaN(parseInt(associativeArray["VehicleSpeed"]))
          ? ""
          : parseInt(associativeArray["VehicleSpeed"]), // speed
        associativeArray["Odometer"], // odometer
        parseInt(associativeArray["Soc"]), // soc
        "", // TODO: elevation is not available
        associativeArray["GpsHeading"] ?? "", // est_heading (TODO: is this the good field?)
        associativeArray["Latitude"], // est_lat
        associativeArray["Longitude"], // est_lng
        power, // power
        associativeArray["Gear"] ?? "", // 0 shift_state
        associativeArray["RatedRange"], // range
        associativeArray["EstBatteryRange"], // est_range
        associativeArray["GpsHeading"] ?? "", // heading
      ].join(","),
    };

    if (!associativeArray["Gear"] && !isCharging) {
      console.log(r);
      if (tags[jsonData.vin]) {
        tags[jsonData.vin].close();
      }
      return;
      /*return {
        msg_type: "data:error",
        tag: jsonData.vin,
        error_type: "vehicle_error",
        value: "Vehicle is offline",
      };*/
    }

    return r;
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
      console.log("Send to client " + msg.tag);
      console.log(JSON.stringify(msg));
      tags[msg.tag].send(JSON.stringify(msg));
    }
  } catch (e) {
    console.error(e);
  }
}

app.listen(8081, () => console.log("listening on http://localhost:8081/"));
