var express = require("express");
const { WebSocket } = require("ws");
var app = express();
require("express-ws")(app);
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/", (req, res) => {
  let data = req.body.message.data;
  let buff = new Buffer.from(data, "base64");
  let message = buff.toString("ascii");

  broadcastMessage(message);
  res.status(200).json({ status: "ok" });
});

// Save ws associated with each tag
let tags = {};

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
    console.log("Get message: %s", message);

    const js = JSON.parse(message);
    if (js.msg_type == "data:subscribe_oauth") {
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
        delete tags[keys[i]];
      }
    }
  });
});

/**
 * Forward a message from Tesla Telemetry to the websocket streaming client(s)
 * @param {*} message
 */
function broadcastMessage(message) {
  try {
    const jsonData = JSON.parse(message);
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
    const r = {
      msg_type: "data:update",
      tag: jsonData.vin,
      value: [
        new Date(jsonData.createdAt).getTime(),
        associativeArray["VehicleSpeed"] ?? 0, // speed
        associativeArray["Odometer"], // odometer
        associativeArray["Soc"], // soc
        0, // elevation (not available)
        associativeArray["GpsHeading"] || 0, // est_heading (TODO: is this the good field?)
        associativeArray["Latitude"], // est_lat
        associativeArray["Longitude"], // est_lng
        0, // power (wait for https://github.com/teslamotors/fleet-telemetry/issues/170#issuecomment-2141034274)
        associativeArray["Gear"] ?? 0, // 0 shift_state
        associativeArray["RatedRange"], // range
        associativeArray["EstBatteryRange"], // est_range
        associativeArray["GpsHeading"] || 0, // heading
      ].join(","),
    };

    if (r.tag in tags && tags[r.tag].readyState === WebSocket.OPEN) {
      console.log("Send to client " + r.tag);
      tags[r.tag].send(JSON.stringify(r));
    }
  } catch (e) {
    console.error(e);
  }
}

app.listen(8081, () => console.log("listening on http://localhost:8081/"));
