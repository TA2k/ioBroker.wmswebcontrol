![Logo](admin/wmswebcontrol.png)

# ioBroker.wmswebcontrol

[![NPM version](https://img.shields.io/npm/v/iobroker.wmswebcontrol.svg)](https://www.npmjs.com/package/iobroker.wmswebcontrol)
[![Downloads](https://img.shields.io/npm/dm/iobroker.wmswebcontrol.svg)](https://www.npmjs.com/package/iobroker.wmswebcontrol)
![Number of Installations (latest)](https://iobroker.live/badges/wmswebcontrol-installed.svg)
![Number of Installations (stable)](https://iobroker.live/badges/wmswebcontrol-stable.svg)
[![Dependency Status](https://img.shields.io/david/TA2k/iobroker.wmswebcontrol.svg)](https://david-dm.org/TA2k/iobroker.wmswebcontrol)

[![NPM](https://nodei.co/npm/iobroker.wmswebcontrol.png?downloads=true)](https://nodei.co/npm/iobroker.wmswebcontrol/)

**Tests:** ![Test and Release](https://github.com/TA2k/ioBroker.wmswebcontrol/workflows/Test%20and%20Release/badge.svg)

## wmswebcontrol adapter for ioBroker

Adapter for Warema WMS Webcontrol

## Setup

The adapter supports two connection paths and prefers the local one:

- **Local (recommended):** enter the WMS controller's IP in **Local IP**, or enable
  **Auto-discovery** to scan the local network for it. The controller's local API needs no
  login. This path keeps working even when the Warema cloud or its IoT hub is unavailable.
- **Cloud:** enter your Warema **username** and **password**. Used as a fallback when the
  controller cannot be reached on the LAN, and to look up the controller when the local path
  is not configured.

You can configure both: the adapter drives the controller locally when it is reachable and
falls back to the cloud otherwise. The cloud fallback is only used for a single-controller
account (the local controller cannot be matched to a specific one otherwise).

## Usage

### Local mode (commonCommand)

When the controller is reachable, the adapter builds a `local.*` tree from its configuration:

- `local.<device>.position` - target position 0..100 % (writable).
- `local.<device>.slatAngle` - target slat angle, range per device (writable, blinds only).
- `local.<device>.stop` - button, stops the current movement (writable).
- `local.<device>.drivingCause` / `.heartbeatError` / `.blocking` - status (read-only).
- `local.scenes.<scene>` - button, runs the scene (writable).

### Cloud mode (legacy)

When only the cloud path is available, the adapter exposes the controller's devices, scenes
and channels. To control a channel change the `*Convert` values, e.g.:

`wmswebcontrol.0.Markise+XXXX.setting0Convert`

`wmswebcontrol.0.LED+XXXXXXX.setting1Convert`

`wmswebcontrol.0.Markise.setting2Convert`

## Changelog

### **WORK IN PROGRESS**

- add local commonCommand control (IP or auto-discovery), preferred over the cloud with a
  cloud fallback
- use axios for all HTTP calls, drop @esm2cjs/got
- resolve service endpoints from the discovery service

### 0.1.4 (2025-01-27)

- ignore certificate errors

### 0.1.3 (2024-10-26)

- fix login

### 0.1.2

- Bugfixes

### 0.0.3

- (TA2k) initial release

## License

MIT License

Copyright (c) 2021-2030 TA2k <tombox2020@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
