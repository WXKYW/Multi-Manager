//! Mix two PCM16 sources (loopback + mic) into one stream for the RTMP path.
//!
//! v1 mixing is deliberately simple: align channel count, sum sample-by-sample,
//! and clip. It assumes both sources share a sample rate (true when both use the
//! default 48 kHz device mix format); if they differ, callers should resample
//! first — not handled here to keep v1 lean.
//!
//! ponytail: sum+clip mixer, no gain/limiter; add a soft limiter if summed
//! peaks clip audibly.

/// Mix two interleaved PCM16 buffers of the same channel count into one.
/// If lengths differ (sources rarely deliver identical frame counts), the
/// shorter is treated as zero-padded — the extra tail of the longer passes
/// through unmixed. Returns interleaved PCM16 bytes.
pub fn mix_pcm16(a: &[u8], b: &[u8]) -> Vec<u8> {
    let sa = as_i16(a);
    let sb = as_i16(b);
    let n = sa.len().max(sb.len());
    let mut out = Vec::with_capacity(n * 2);
    for i in 0..n {
        let x = *sa.get(i).unwrap_or(&0) as i32;
        let y = *sb.get(i).unwrap_or(&0) as i32;
        let s = (x + y).clamp(i16::MIN as i32, i16::MAX as i32) as i16;
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

fn as_i16(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_and_clips() {
        // 20000 + 20000 = 40000 -> clip to 32767; -20000 + -20000 -> -32768.
        let a = [20000i16, -20000].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>();
        let b = a.clone();
        let mixed = as_i16(&mix_pcm16(&a, &b));
        assert_eq!(mixed[0], 32767);
        assert_eq!(mixed[1], -32768);
    }

    #[test]
    fn zero_pads_shorter_source() {
        let a = [1000i16, 2000].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>();
        let b = [500i16].iter().flat_map(|s| s.to_le_bytes()).collect::<Vec<_>>();
        let mixed = as_i16(&mix_pcm16(&a, &b));
        assert_eq!(mixed, vec![1500, 2000]); // second sample: 2000 + 0
    }
}
