# Websocket server to reproduce old streaming API with new Tesla Telemetry events

Create an express server with :

- a route used in a GCP Pub/Sub to receive Telemtry event
- a websocket server listening on /streaming

## TeslaMate usage

A Teslamate instance can use this websocket server as streaming source.

## Limitations

- [Live power is not available](https://github.com/teslamotors/fleet-telemetry/issues/170) : wait for Telemetry team. Power value is 0.
- Live elevation is not available
