use crate::modes::ModeState;

pub const CHECKPOINT_INTERVAL: u64 = 256 * 1024;

#[derive(Clone, Copy)]
struct Checkpoint {
    offset: u64,
    modes: ModeState,
}

pub struct LocateResult<'a> {
    pub cp_offset: u64,
    pub cp_modes: ModeState,
    pub replay_bytes: &'a [u8],
}

pub struct CheckpointStore {
    checkpoints: Vec<Checkpoint>,
    recent_bytes: Vec<u8>,
    recent_start: u64,
}

impl Default for CheckpointStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CheckpointStore {
    pub fn new() -> Self {
        Self {
            checkpoints: vec![Checkpoint {
                offset: 0,
                modes: ModeState::default(),
            }],
            recent_bytes: Vec::new(),
            recent_start: 0,
        }
    }

    pub fn record(&mut self, bytes: &[u8], offset_before: u64, modes_after: &ModeState) {
        if bytes.is_empty() {
            return;
        }
        let offset_after = offset_before + bytes.len() as u64;
        self.recent_bytes.extend_from_slice(bytes);

        let last_cp = self.checkpoints.last().unwrap().offset;
        let next_boundary = ((last_cp / CHECKPOINT_INTERVAL) + 1) * CHECKPOINT_INTERVAL;

        if offset_after >= next_boundary {
            self.checkpoints.push(Checkpoint {
                offset: offset_after,
                modes: *modes_after,
            });

            if self.checkpoints.len() >= 2 {
                let penultimate = self.checkpoints[self.checkpoints.len() - 2].offset;
                if penultimate > self.recent_start {
                    let trim = (penultimate - self.recent_start) as usize;
                    if trim <= self.recent_bytes.len() {
                        self.recent_bytes.drain(..trim);
                    } else {
                        self.recent_bytes.clear();
                    }
                    self.recent_start = penultimate;
                }
            }
        }
    }

    pub fn locate(&self, offset: u64) -> Option<LocateResult<'_>> {
        // Binary search for largest checkpoint with offset <= requested offset.
        let mut lo = 0usize;
        let mut hi = self.checkpoints.len();
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if self.checkpoints[mid].offset <= offset {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        if self.checkpoints[lo].offset > offset {
            return None;
        }
        let cp = self.checkpoints[lo];

        let window_start = self.recent_start;
        let window_end = window_start + self.recent_bytes.len() as u64;
        let eff_start = cp.offset.max(window_start);
        let eff_end = offset.min(window_end);

        let replay = if eff_start <= eff_end && eff_start >= window_start && eff_end <= window_end {
            let s = (eff_start - window_start) as usize;
            let e = (eff_end - window_start) as usize;
            &self.recent_bytes[s..e]
        } else {
            &[]
        };

        Some(LocateResult {
            cp_offset: cp.offset,
            cp_modes: cp.modes,
            replay_bytes: replay,
        })
    }
}
