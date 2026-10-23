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

/// Crockford base32, lowercase: the digits and the letters, less `i`, `l`,
/// `o` and `u`. Spec §8.3.
const CROCKFORD: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";

/// Whether `s` is an identifier as the specification defines one. Spec §8.3.
///
/// Lowercase only. The ULID specification calls uppercase canonical but
/// makes its decoder case-insensitive, so Fjord's identifier is a profile of
/// ULID and not a different thing: same 128 bits, same sort order, one
/// spelling. Uppercase is rejected because §8.3 permits "exactly one
/// identifier form", so that clients can compare identifiers byte-wise
/// without normalising first — and a validator that accepted both would
/// quietly bring back the negotiation that rule exists to avoid.
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
///
/// Reads the system clock, so it is not in the pure subset: a caller with no clock of its own to
/// trust (a web page) passes the time in and uses [`rfc3339_utc_from_unix`].
#[cfg(feature = "native")]
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

/// Whether `s` would be an identifier if its case were ignored. Spec §8.3.
///
/// **For explaining a rejection, never for accepting one.** Repositories
/// created by Fjord 0.1.0 carry uppercase identifiers, which §8.3 used to
/// require, so the most likely reason a valid-looking id is refused is that
/// it is the old spelling — and "not a valid ULID" would send someone
/// looking for a typo that is not there.
pub fn is_ulid_ignoring_case(s: &str) -> bool {
    is_ulid(&s.to_ascii_lowercase())
}

/// A fresh identifier. Spec §8.3.
///
/// Identifier generation lives here rather than in each caller, so that
/// "exactly one identifier form is permitted" is enforced by there being
/// exactly one way to make one. The `ulid` crate emits uppercase, the
/// ULID specification's canonical form; this is where it becomes Fjord's.
///
/// Reads the system clock and a random source, so it is not in the pure subset: see [`new_ulid_from`].
#[cfg(feature = "native")]
pub fn new_ulid() -> String {
    // `generate` in ulid 3; it was `new` before 3.0.
    ulid::Ulid::generate().to_string().to_ascii_lowercase()
}

/// An identifier made from a time and some randomness the caller supplies. Spec §8.3.
///
/// What [`new_ulid`] is, with the two things a WebAssembly build has no business assuming handed in:
/// milliseconds since the Unix epoch (a ULID holds 48 bits of it, so a larger value is cut to them) and
/// 80 random bits (the first ten bytes of `random`; its remaining bytes are ignored, and an identifier
/// is only as unguessable as these are).
pub fn new_ulid_from(timestamp_ms: u64, random: [u8; 16]) -> String {
    let mut bits: u128 = 0;
    for byte in &random[..10] {
        bits = (bits << 8) | u128::from(*byte);
    }
    ulid::Ulid::from_parts(timestamp_ms & ((1 << 48) - 1), bits)
        .to_string()
        .to_ascii_lowercase()
}

/// A time given as seconds since the Unix epoch, as RFC 3339 in UTC, or `None` if it cannot be
/// represented. The pure counterpart of [`now_rfc3339_utc`]: the caller says what time it is.
pub fn rfc3339_utc_from_unix(seconds: i64) -> Option<String> {
    use time::format_description::well_known::Rfc3339;

    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&Rfc3339)
        .ok()
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
        assert!(is_ulid("01jagc4k7pqw2xn8rvty5zb3md"));
        assert!(is_ulid("00000000000000000000000000"));
        assert!(is_ulid("7zzzzzzzzzzzzzzzzzzzzzzzzz"));
    }

    #[test]
    fn rejects_wrong_length() {
        assert!(!is_ulid(""));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3M"));
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MDD"));
    }

    #[test]
    fn rejects_characters_outside_crockford() {
        // i, l, o and u are excluded precisely because they are misread.
        // Lowercase, so each fails for its letter and not for its case.
        assert!(!is_ulid("01jagc4k7pqw2xn8rvty5zb3mi"));
        assert!(!is_ulid("01jagc4k7pqw2xn8rvty5zb3ml"));
        assert!(!is_ulid("01jagc4k7pqw2xn8rvty5zb3mo"));
        assert!(!is_ulid("01jagc4k7pqw2xn8rvty5zb3mu"));
        assert!(!is_ulid("01jagc4k7pqw2xn8rvty5zb3m-"));
    }

    #[test]
    fn rejects_uppercase() {
        // §8.3 used to require this spelling. Fjord 0.1.0 wrote it, and it
        // is what the `ulid` crate emits, so it is the likeliest mistake.
        assert!(!is_ulid("01JAGC4K7PQW2XN8RVTY5ZB3MD"));
        // A mixed-case id is no better: there is exactly one form.
        assert!(!is_ulid("01jagc4k7pQW2xn8rvty5zb3md"));
    }

    #[test]
    fn the_old_spelling_is_recognised_so_it_can_be_explained() {
        assert!(is_ulid_ignoring_case("01JAGC4K7PQW2XN8RVTY5ZB3MD"));
        assert!(is_ulid_ignoring_case("01jagc4k7pqw2xn8rvty5zb3md"));
        // But only when the case is the *only* thing wrong.
        assert!(!is_ulid_ignoring_case("01JAGC4K7PQW2XN8RVTY5ZB3MI"));
        assert!(!is_ulid_ignoring_case("not-a-ulid"));
        assert!(!is_ulid_ignoring_case(""));
    }

    #[test]
    fn rejects_overflowing_first_character() {
        // Lowercase, so these fail for overflow and not for their case.
        assert!(!is_ulid("8zzzzzzzzzzzzzzzzzzzzzzzzz"));
        assert!(!is_ulid("zzzzzzzzzzzzzzzzzzzzzzzzzz"));
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

    #[cfg(feature = "native")]
    #[test]
    fn the_clock_produces_a_value_we_accept() {
        let now = now_rfc3339_utc();
        assert!(is_rfc3339_utc(&now), "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert!(!now.contains('.'), "{now}");
    }

    #[cfg(feature = "native")]
    #[test]
    fn generated_ulids_satisfy_our_own_validator() {
        for _ in 0..32 {
            let id = new_ulid();
            assert!(is_ulid(&id), "{id} is not a ULID by our own rule");
            assert_eq!(id, id.to_ascii_lowercase(), "{id} is not lowercase");
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

    #[test]
    fn an_identifier_from_a_time_and_randomness_is_the_one_form_the_spec_permits() {
        let id = new_ulid_from(1_700_000_000_000, [7; 16]);
        assert!(is_ulid(&id), "{id}");
        assert_eq!(id, id.to_ascii_lowercase());
    }

    #[test]
    fn the_same_time_and_randomness_make_the_same_identifier_and_different_ones_do_not() {
        assert_eq!(new_ulid_from(5, [1; 16]), new_ulid_from(5, [1; 16]));
        assert_ne!(new_ulid_from(5, [1; 16]), new_ulid_from(5, [2; 16]));
        assert_ne!(new_ulid_from(5, [1; 16]), new_ulid_from(6, [1; 16]));
    }

    #[test]
    fn identifiers_sort_by_the_time_they_were_made() {
        let earlier = new_ulid_from(1_000, [255; 16]);
        let later = new_ulid_from(2_000, [0; 16]);
        assert!(earlier < later);
    }

    #[test]
    fn only_ten_bytes_of_randomness_count_and_only_forty_eight_bits_of_time() {
        // The last six bytes are ignored: an identifier holds 80 random bits.
        let mut tail = [9; 16];
        tail[15] = 200;
        assert_eq!(new_ulid_from(1, [9; 16]), new_ulid_from(1, tail));
        // A time past 48 bits is cut to them, never an invalid identifier.
        let huge = new_ulid_from(u64::MAX, [0; 16]);
        assert!(is_ulid(&huge), "{huge}");
    }

    #[test]
    fn a_time_given_in_seconds_is_formatted_as_the_spec_requires() {
        assert_eq!(
            rfc3339_utc_from_unix(0).as_deref(),
            Some("1970-01-01T00:00:00Z")
        );
        let formatted = rfc3339_utc_from_unix(1_700_000_000).expect("a timestamp");
        assert_eq!(formatted, "2023-11-14T22:13:20Z");
        assert!(is_rfc3339_utc(&formatted));
        assert_eq!(rfc3339_utc_from_unix(i64::MAX), None);
    }
}
