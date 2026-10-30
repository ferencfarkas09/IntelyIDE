# Devices fixture

Fake `xcrun`, `adb`, `emulator` and `npx` for the tests of `crates/devices` and the React Native panel. They print canned
data from `data/`, never touch a device, a network or `~`, and log every call (argv only) to `$FAKE_DEVICES_LOG` when
it is set. `FAKE_MODE` picks a behaviour: `ok` (default), `empty` (no devices), `garbled` (hostile output), `fail`
(exit 1 with a message on stderr), `hang` (never answers; the caller's timeout must end it).
