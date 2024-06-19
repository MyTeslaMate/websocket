# Tesla Streaming from official Telemetry events

This application contains an express server with :

- a route used in a GCP Pub/Sub to receive Telemetry event
- a websocket server listening on /streaming which send Telemetry event to client.

## Usage

A Teslamate instance can use this WSS as streaming source.

## Limitations

- [Live power is not available](https://github.com/teslamotors/fleet-telemetry/issues/170) : wait for Telemetry team. Power value is 0.
- Live elevation is not available
