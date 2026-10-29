//! Pure parsers for the output of `xcrun simctl list devices available -j`, `emulator -list-avds`, `adb devices -l` and
//! the lines of `log stream` / `logcat`. Input is hostile (a repository can name devices, a tool can print anything):
//! every function accepts any text, caps what it returns and drops what does not fit the expected shape.

use crate::types::{AdbState, AndroidDevice, IosSimulator, Level, SimState};

pub const MAX_DEVICES: usize = 200;
pub const MAX_LINE: usize = 2000;

/// Characters that draw nothing but can hide or reorder text: zero-width and bidi characters, variation selectors, the
/// Unicode tag characters that can carry an invisible message.
fn is_format(c: char) -> bool {
    matches!(c, '\u{200b}'..='\u{200f}' | '\u{2060}'..='\u{2064}' | '\u{feff}' | '\u{00ad}' | '\u{202a}'..='\u{202e}' | '\u{061c}' | '\u{180e}' | '\u{2066}'..='\u{2069}' | '\u{fe00}'..='\u{fe0f}' | '\u{fff9}'..='\u{fffb}' | '\u{e0000}'..='\u{e007f}')
}

/// `text` without control and format characters (a tab becomes a space), at most `max` chars.
pub fn clean(text: &str, max: usize) -> String {
    text.chars().map(|c| if c == '\t' { ' ' } else { c }).filter(|c| !c.is_control() && !is_format(*c)).take(max).collect()
}

/// A simulator UDID: 36 chars of hex and dashes. Anything else never reaches a command line.
pub fn valid_udid(s: &str) -> bool {
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// An AVD name as the emulator lists it.
pub fn valid_avd(s: &str) -> bool {
    !s.is_empty() && s.len() <= 80 && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'+'))
}

/// An adb serial (`emulator-5554`, `R58M123ABC`, `192.168.1.5:5555`).
pub fn valid_serial(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && !s.starts_with('-') && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b':' | b'_' | b'-'))
}

/// `com.apple.CoreSimulator.SimRuntime.iOS-17-5` -> `iOS 17.5`; `None` for tvOS, watchOS, visionOS and anything odd.
fn runtime_name(key: &str) -> Option<String> {
    let tail = key.rsplit('.').next()?;
    let (os, ver) = tail.split_once('-')?;
    if os != "iOS" || ver.is_empty() || ver.len() > 12 || !ver.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return None;
    }
    Some(format!("iOS {}", ver.replace('-', ".")))
}

pub fn parse_simctl(json: &str) -> Vec<IosSimulator> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let Some(runtimes) = root.get("devices").and_then(|d| d.as_object()) else { return Vec::new() };
    let mut out = Vec::new();
    for (key, list) in runtimes {
        let Some(runtime) = runtime_name(key) else { continue };
        let Some(list) = list.as_array() else { continue };
        for d in list {
            let (Some(udid), Some(name)) = (d.get("udid").and_then(|v| v.as_str()), d.get("name").and_then(|v| v.as_str())) else { continue };
            if !valid_udid(udid) || d.get("isAvailable").and_then(|v| v.as_bool()) == Some(false) {
                continue;
            }
            let state = match d.get("state").and_then(|v| v.as_str()).unwrap_or("") {
                "Booted" => SimState::Booted,
                "Shutdown" => SimState::Shutdown,
                _ => SimState::Busy,
            };
            let name = clean(name, 80);
            if name.trim().is_empty() {
                continue;
            }
            out.push(IosSimulator { udid: udid.to_owned(), name, runtime: runtime.clone(), state });
            if out.len() >= MAX_DEVICES {
                return sorted(out);
            }
        }
    }
    sorted(out)
}

fn sorted(mut v: Vec<IosSimulator>) -> Vec<IosSimulator> {
    v.sort_by(|a, b| (a.state != SimState::Booted, &b.runtime, &a.name).cmp(&(b.state != SimState::Booted, &a.runtime, &b.name)));
    v
}

/// One AVD name per line. Newer emulators also print `INFO | ...` lines: they contain spaces or a bar and are dropped.
pub fn parse_avds(out: &str) -> Vec<String> {
    let mut v: Vec<String> = out.lines().map(str::trim).filter(|l| valid_avd(l)).map(str::to_owned).collect();
    v.sort();
    v.dedup();
    v.truncate(100);
    v
}

pub fn parse_adb(out: &str) -> Vec<AndroidDevice> {
    let mut devices = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('*') || line.starts_with("List of devices") || line.starts_with("adb server") {
            continue;
        }
        let mut tokens = line.split_whitespace();
        let (Some(serial), Some(state)) = (tokens.next(), tokens.next()) else { continue };
        if !valid_serial(serial) {
            continue;
        }
        let state = match state {
            "device" => AdbState::Device,
            "offline" => AdbState::Offline,
            "unauthorized" => AdbState::Unauthorized,
            "no" => AdbState::NoPermissions,
            _ => AdbState::Other,
        };
        let (mut model, mut product) = (None, None);
        for t in tokens {
            if let Some(v) = t.strip_prefix("model:") {
                model = Some(clean(&v.replace('_', " "), 60)).filter(|m| !m.is_empty());
            } else if let Some(v) = t.strip_prefix("product:") {
                product = Some(clean(v, 60)).filter(|m| !m.is_empty());
            }
        }
        devices.push(AndroidDevice { serial: serial.to_owned(), state, model, product, is_emulator: serial.starts_with("emulator-") });
        if devices.len() >= MAX_DEVICES {
            break;
        }
    }
    devices
}

fn text_level(lower: &str) -> Level {
    const ERROR: [&str; 9] = ["fatal exception", "unhandled js exception", "uncaught exception", "terminating app", "invariant violation", "fatal signal", "redbox", " error:", "exception:"];
    if ERROR.iter().any(|k| lower.contains(k)) {
        Level::Error
    } else if lower.contains("warn") {
        Level::Warn
    } else {
        Level::Info
    }
}

/// iOS `--style compact`: `2024-05-01 10:00:00.123 Df  App[123:456] message`; the type column is `E`/`Er`, `F`/`Fa`
/// (error, fault), `Df`, `Db`, `I`/`In`. Android `threadtime`: `05-01 10:00:00.123  1234  5678 E Tag: message`.
/// A line that fits neither shape is classified by what it says.
pub fn classify_line(line: &str) -> Level {
    let lower = line.to_ascii_lowercase();
    let t: Vec<&str> = line.split_whitespace().take(6).collect();
    if t.len() >= 3 && t[0].len() == 10 && t[0].as_bytes()[4] == b'-' {
        match t[2] {
            "E" | "Er" | "Err" | "F" | "Fa" | "Fault" => return Level::Error,
            "W" | "Wa" => return Level::Warn,
            "Df" | "Db" | "I" | "In" => return text_level(&lower),
            _ => {}
        }
    }
    if t.len() >= 6 && t[0].len() == 5 && t[0].as_bytes()[2] == b'-' && t[2].bytes().all(|b| b.is_ascii_digit()) && t[3].bytes().all(|b| b.is_ascii_digit()) {
        match t[4] {
            "E" | "F" | "A" => return Level::Error,
            "W" => return Level::Warn,
            "V" | "D" | "I" => return text_level(&lower),
            _ => {}
        }
    }
    text_level(&lower)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIMCTL: &str = include_str!("../../../scripts/devices-fixture/data/simctl.json");
    const SIMCTL_BAD: &str = include_str!("../../../scripts/devices-fixture/data/simctl-garbled.json");
    const ADB: &str = include_str!("../../../scripts/devices-fixture/data/adb.txt");
    const ADB_BAD: &str = include_str!("../../../scripts/devices-fixture/data/adb-garbled.txt");

    #[test]
    fn simctl_lists_ios_simulators_booted_first_and_skips_other_platforms() {
        let sims = parse_simctl(SIMCTL);
        assert_eq!(sims.len(), 4);
        assert_eq!((sims[0].name.as_str(), sims[0].state), ("iPhone 15", SimState::Booted));
        assert_eq!(sims[0].runtime, "iOS 17.5");
        assert!(sims.iter().all(|s| s.runtime.starts_with("iOS ")), "no tvOS or watchOS");
        assert_eq!(sims.iter().find(|s| s.name.starts_with("iPhone SE")).unwrap().state, SimState::Busy);
        assert!(sims.iter().any(|s| s.runtime == "iOS 16.4"));
    }

    #[test]
    fn simctl_survives_garbage() {
        for bad in ["", "{", "null", "[]", "{\"devices\": 3}", "{\"devices\": {\"a\": 4}}", "\u{0}\u{1b}[31m"] {
            assert!(parse_simctl(bad).is_empty(), "{bad:?}");
        }
        let sims = parse_simctl(SIMCTL_BAD);
        assert_eq!(sims.len(), 1, "only the entry with a real UDID and a text name stays: {sims:?}");
        assert!(!sims[0].name.contains('\u{1b}') && !sims[0].name.contains('\u{7}'));
    }

    #[test]
    fn simctl_caps_the_number_of_devices() {
        let one = |i: usize| format!("{{\"udid\":\"6D0F0B7E-1A2B-4C3D-8E4F-{i:012X}\",\"name\":\"d{i}\",\"state\":\"Shutdown\"}}");
        let list: Vec<String> = (0..500).map(one).collect();
        let json = format!("{{\"devices\":{{\"com.apple.CoreSimulator.SimRuntime.iOS-17-5\":[{}]}}}}", list.join(","));
        assert_eq!(parse_simctl(&json).len(), MAX_DEVICES);
    }

    #[test]
    fn ids_are_validated_before_they_reach_a_command_line() {
        assert!(valid_udid("6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01"));
        for bad in [
            "", "6D0F0B7E", "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E0;", "--help", "6D0F0B7E1A2B4C3D8E4F5A6B7C8D9E01XXXX",
            "-D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01", "-D0F0B7E1A2B-4C3D-8E4F-5A6B7C8D9E01", "--F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01-", "6D0F0B7E-1A2B-4C3D-8E4F5-A6B7C8D9E01", "6D0F0B7E1-A2B-4C3D-8E4F-5A6B7C8D9E01", "6D0F0B7E-1A2B-4C3D-8E4F-5A6B7C8D9E01\n",
        ] {
            assert!(!valid_udid(bad), "{bad}");
        }
        assert!(valid_avd("Pixel_7_API_34") && valid_avd("Pixel-7.1"));
        for bad in ["", "-wipe-data", "a b", "a;b", "../x", "$(x)", &"a".repeat(81)] {
            assert!(!valid_avd(bad), "{bad}");
        }
        assert!(valid_serial("emulator-5554") && valid_serial("192.168.1.20:5555"));
        for bad in ["", "-s", "a b", "a;b", "$(x)"] {
            assert!(!valid_serial(bad), "{bad}");
        }
    }

    #[test]
    fn avd_list_ignores_info_lines_and_odd_names() {
        let avds = parse_avds(include_str!("../../../scripts/devices-fixture/data/avds.txt"));
        assert_eq!(avds, ["Pixel_7_API_34", "Pixel_Tablet_API_33"]);
        let bad = parse_avds(include_str!("../../../scripts/devices-fixture/data/avds-garbled.txt"));
        assert_eq!(bad, ["Good_One"]);
        assert!(parse_avds("").is_empty());
    }

    #[test]
    fn adb_devices_long_format() {
        let d = parse_adb(ADB);
        assert_eq!(d.len(), 4);
        assert_eq!((d[0].serial.as_str(), d[0].state, d[0].is_emulator), ("emulator-5554", AdbState::Device, true));
        assert_eq!(d[0].model.as_deref(), Some("sdk gphone64 arm64"));
        assert_eq!((d[1].model.as_deref(), d[1].is_emulator), (Some("SM G973F"), false));
        assert_eq!(d[2].state, AdbState::Unauthorized);
        assert_eq!((d[3].serial.as_str(), d[3].state), ("192.168.1.20:5555", AdbState::Offline));
    }

    #[test]
    fn adb_no_permissions_state() {
        let d = parse_adb("List of devices attached\nABC123  no permissions (user in plugdev group; are your udev rules wrong?); see [http://x] usb:1-1\n");
        assert_eq!((d.len(), d[0].state), (1, AdbState::NoPermissions));
    }

    #[test]
    fn adb_survives_garbage() {
        let d = parse_adb(ADB_BAD);
        assert_eq!(d.iter().map(|x| x.serial.as_str()).collect::<Vec<_>>(), ["ok-serial"]);
        for bad in ["", "\0\0\0", "List of devices attached", "* daemon started successfully", &"x ".repeat(10_000)] {
            let _ = parse_adb(bad);
        }
        assert!(parse_adb("List of devices attached\n\n").is_empty());
        let many: String = (0..1000).map(|i| format!("dev{i} device\n")).collect();
        assert_eq!(parse_adb(&many).len(), MAX_DEVICES);
    }

    #[test]
    fn ios_compact_lines_are_classified_by_their_type_column() {
        assert_eq!(classify_line("2024-05-01 10:00:01.200 E   MyApp[1:2] boom"), Level::Error);
        assert_eq!(classify_line("2024-05-01 10:00:01.200 Fa  MyApp[1:2] boom"), Level::Error);
        assert_eq!(classify_line("2024-05-01 10:00:01.200 Df  MyApp[1:2] hello"), Level::Info);
        assert_eq!(classify_line("2024-05-01 10:00:01.200 Df  MyApp[1:2] WARN  Require cycle"), Level::Warn);
        assert_eq!(classify_line("2024-05-01 10:00:03.400 Df  MyApp[1:2] *** Terminating app due to uncaught exception"), Level::Error);
    }

    #[test]
    fn logcat_threadtime_lines_are_classified_by_their_priority() {
        assert_eq!(classify_line("05-01 10:00:02.300  1234  5678 E ReactNativeJS: TypeError"), Level::Error);
        assert_eq!(classify_line("05-01 10:00:02.300  1234  5678 F libc    : Fatal signal 11"), Level::Error);
        assert_eq!(classify_line("05-01 10:00:01.200  1234  5678 W ReactNativeJS: cycle"), Level::Warn);
        assert_eq!(classify_line("05-01 10:00:00.100  1234  5678 I ReactNativeJS: Running"), Level::Info);
        assert_eq!(classify_line("05-01 10:00:00.100  1234  5678 D ReactNative: FATAL EXCEPTION in text"), Level::Error);
    }

    #[test]
    fn classification_falls_back_to_the_text_and_survives_garbage() {
        assert_eq!(classify_line("--------- beginning of main"), Level::Info);
        assert_eq!(classify_line("Warning: Each child in a list should have a unique key"), Level::Warn);
        assert_eq!(classify_line("Invariant Violation: x"), Level::Error);
        for bad in ["", "   ", "\0\u{1b}[31m", "2024-05-01", "05-01 a b c d e", "9999-99-99 99:99 E", &"E ".repeat(5000)] {
            let _ = classify_line(bad);
        }
    }

    #[test]
    fn clean_strips_control_characters_and_caps() {
        assert_eq!(clean("a\u{1b}[31mb\tc\u{7}", 10), "a[31mb c");
        assert_eq!(clean(&"é".repeat(100), 5).chars().count(), 5);
        assert_eq!(clean("a\u{200b}b\u{202e}c\u{e0041}d\u{85}e\u{fe0f}", 10), "abcde", "format and C1 characters go too");
    }
}
