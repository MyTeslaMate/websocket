# Tesla Streaming from official Telemetry events

This application contains an express server with :

- a route to receive Tesla Telemetry events
- a websocket server which forward Telemetry events to connected clients

## Usage

A Teslamate instance can use this WSS as streaming source.

## Limitations

- [Live power is not available](https://github.com/teslamotors/fleet-telemetry/issues/170) : wait for Telemetry team. Power value is 0.
- Live elevation is not available
