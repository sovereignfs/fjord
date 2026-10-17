// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The two scalar formats the specification fixes.
//!
//! Both are validated as strings rather than parsed into rich types,
//! deliberately. A malformed `id` must surface as
//! [`Code::DocumentIdInvalid`][crate::diagnostics::Code::DocumentIdInvalid],
//! not as a parse failure that aborts the whole file — so the typed
//! conversion happens after validation, where a caller needs it, and never
//! during deserialisation.

/// Length of a ULID in characters. Spec §8.3.
pub const ULID_LENGTH: usize = 26;

/// Crockford base32, uppercase: the digits and the letters, less `I`, `L`,
/// `O` and `U`. Spec §8.3.
const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Whether `s` is a ULID as the specification defines one. Spec §8.3.
///
/// Stricter than a permissive ULID parser: lowercase is rejected, because
/// §8.3 permits "exactly one identifier form" so that clients can compare
/// identifiers byte-wise without normalising first.
pub fn is_ulid(s: &str) -> bool {
    if s.len() != ULID_LENGTH {
        return false;
    }
    let bytes = s.as_bytes();
    if !bytes.iter().all(|b| CROCKFORD.contains(b)) {
        return false;
    }
    // The first character carries the top 3 bits of a 48-bit timestamp in a
    // 128-bit value, so anything above '7' overflows and is not a ULID even
    // though every character is in the alphabet.
    bytes[0] <= b'7'
}

/// Whether `s` is an RFC 3339 timestamp in UTC. Spec §3, §4, §8.1.
///
/// The specification says "MUST be UTC, with `Z`". A `+00:00` offset denotes
/// the same instant and is accepted: rejecting it would fail a file that is
/// unambiguously correct, and no information is lost either way.
pub fn is_rfc3339_utc(s: &str) -> bool {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;

    match OffsetDateTime::parse(s, &Rfc3339) {
        Ok(parsed) => parsed.offset().is_utc(),
        Err(_) => false,
    }
}

/// Now, as RFC 3339 in UTC with whole seconds. Spec §3, §4, §8.1.
///
/// Subsecond precision is dropped: it is noise in a creation timestamp, and
/// a whole-second value is what someone reading a manifest expects.
pub fn now_rfc3339_utc() -> String {
    use time::format_description::well_known::Rfc3339;
    use time::OffsetDateTime;

    let now = OffsetDateTime::now_utc();
    let now = match now.replace_nanosecond(0) {
        Ok(truncated) => truncated,
        Err(_) => now,
    };
    match now.format(&Rfc3339) {
        Ok(formatted) => formatted,
        // Unreachable for a well-formed OffsetDateTime, and not worth a
        // panic in a crate that forbids them.
        Err(_) => "1970-01-01T00:00:00Z".to_string(),
    }
}

/// A fresh ULID. Spec §8.3.
///
/// Identifier generation lives here rather than in each caller, so that
/// "exactly one identifier form is permitted" is enforced by there being
/// exactly one way to make one.
pub fn new_ulid() -> String {
    // `generate` in ulid 3; it was `new` before 3.0.
    ulid::Ulid::generate().to_string()
}

/// A filesystem timestamp as RFC 3339 in UTC, or `None` if it predates the
/// epoch or cannot be represented.
pub fn rfc3339_utc(at: std::time::SystemTime) -> Option<String> {
    use time::format_description::well_known::Rfc3339;

    let seconds = at
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs()
        .try_into()
        .ok()?;
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_real_ulid() {
        assert!(is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MD"));
        assert!(is_ulid("00000000000000000000000000"));
        assert!(is_ulid("7ZZZZZZZZZZZZZZZZZZZZZZZZZ"));
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(!is_ulid(""));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3M"));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MDD"));
    }

    #[test]
    fn rejects_characters_outside_crockford() {
        // I, L, O and U are excluded precisely because they are misread.
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MI"));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3ML"));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MO"));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MU"));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3M-"));
    }

    #[test]
    fn rejects_lowercase() {
        assert!(!is_ulid("01jagc4k7pqw2xn8rvty5zb3md"));
    }

    #[test]
    fn rejects_overflowing_first_character() {
        assert!(!is_ulid("8ZZZZZZZZZZZZZZZZZZZZZZZZZ"));
        assert!(!is_ulid("ZZZZZZZZZZZZZZZZZZZZZZZZZZ"));
    }

    #[test]
    fn length_is_counted_in_bytes_not_characters() {
        // Twenty-six bytes, thirteen characters. Must not pass.
        let multibyte = "ééééééééééééé";
        assert_eq!(multibyte.len(), ULID_LENGTH);
        assert!(!is_ulid(multibyte));
    }

    #[test]
    fn accepts_utc_timestamps() {
        assert!(is_rfc3339_utc("2026-10-16T09:34:00Z"));
        assert!(is_rfc3339_utc("2026-10-16T09:34:00.123Z"));
        assert!(is_rfc3339_utc("2026-10-16T09:34:00+00:00"));
    }

    #[test]
    fn the_clock_produces_a_value_we_accept() {
        let now = now_rfc3339_utc();
        assert!(is_rfc3339_utc(&now), "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert!(!now.contains('.'), "{now}");
    }

    #[test]
    fn generated_ulids_satisfy_our_own_validator() {
        for _ in 0..32 {
            let id = new_ulid();
            assert!(is_ulid(&id), "{id} is not a ULID by our own rule");
        }
        assert_ne!(new_ulid(), new_ulid());
    }

    #[test]
    fn a_filesystem_timestamp_formats_as_rfc3339() {
        let formatted = rfc3339_utc(std::time::UNIX_EPOCH).expect("a timestamp");
        assert_eq!(formatted, "1970-01-01T00:00:00Z");
        assert!(is_rfc3339_utc(&formatted));
    }

    #[test]
    fn rejects_offsets_and_rubbish() {
        assert!(!is_rfc3339_utc("2026-10-16T09:34:00+02:00"));
        assert!(!is_rfc3339_utc("2026-10-16"));
        assert!(!is_rfc3339_utc("yesterday"));
        assert!(!is_rfc3339_utc(""));
    }
}
