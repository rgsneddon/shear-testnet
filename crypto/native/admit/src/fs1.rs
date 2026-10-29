//! FS-1 spend (ADMITv3) over the C ABI. The prover and verifier are the
//! vendored monero-oxide FCMP++ adaptation in `shear-fs1` (MIT, Luke Parker,
//! see crypto/native/vendor/monero-oxide-77788c3/THIRD_PARTY_NOTICES).
//!
//! A note is 64 bytes, `admitPub || commit`. A tree handle holds the admit set
//! in chain order. Every function returns 1 or 0 and never unwinds.

use std::panic::{catch_unwind, AssertUnwindSafe};

use curve25519_dalek::Scalar;
use shear_fs1::{
    assemble_external, external_tag, prove_spend, prove_spend_external, prove_spend_unlinked, sal_sign_external,
    spend_blob_len, spend_params, tree_of_notes, verify_spend, verify_spend_unlinked, ChainNote, ChainTree,
    ExternalIn, ExternalSpend, SalRequest, SpendIn, RECORD_BYTES, SAL_BYTES, SAL_REQUEST_BYTES,
};
use zeroize::Zeroizing;

use crate::{slice, BAD, OK};

pub const NOTE_BYTES: usize = 64;
pub const INPUT_MAX: usize = 8;

pub struct Fs1Handle {
    tree: ChainTree,
    notes: Vec<ChainNote>,
}

fn notes_from(bytes: &[u8]) -> Option<Vec<ChainNote>> {
    if bytes.len() % NOTE_BYTES != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(NOTE_BYTES)
            .map(|c| ChainNote {
                admit_pub: c[.. 32].try_into().expect("32 bytes"),
                commit: c[32 ..].try_into().expect("32 bytes"),
            })
            .collect(),
    )
}

impl Fs1Handle {
    pub fn new() -> Option<Self> {
        let params = spend_params().ok()?;
        Some(Self { tree: ChainTree::new(params).ok()?, notes: Vec::new() })
    }

    pub fn len(&self) -> u64 {
        self.tree.len()
    }

    pub fn append(&mut self, notes: &[ChainNote]) -> bool {
        if notes.is_empty() {
            return true;
        }
        let Ok(params) = spend_params() else { return false };
        if self.tree.append_notes(params, notes).is_err() {
            return false;
        }
        self.notes.extend_from_slice(notes);
        true
    }

    pub fn truncate(&mut self, len: u64) -> bool {
        if len >= self.tree.len() {
            return len == self.tree.len();
        }
        let Ok(params) = spend_params() else { return false };
        if self.tree.truncate_notes(params, len).is_err() {
            return false;
        }
        self.notes.truncate(len as usize);
        true
    }

    pub fn root(&self) -> Option<[u8; 32]> {
        (self.tree.len() > 0).then(|| self.tree.root_bytes())
    }
}

/// Inputs and outputs of one prove.
pub struct ProveIo<'a> {
    pub indices: &'a [u64],
    pub xs: &'a [u8],
    pub digest: &'a [u8; 32],
    pub anchor: u64,
    pub threads: usize,
}

pub struct Proven {
    pub fs1: Vec<u8>,
    pub records: Vec<u8>,
    pub t: Zeroizing<Vec<u8>>,
}

pub fn prove_on(handle: &Fs1Handle, io: &ProveIo) -> Option<Proven> {
    let n = io.indices.len();
    if n == 0 || n > INPUT_MAX || io.xs.len() != 32 * n {
        return None;
    }
    let mut inputs = Vec::with_capacity(n);
    for (k, &index) in io.indices.iter().enumerate() {
        let mut repr = Zeroizing::new([0u8; 32]);
        repr.copy_from_slice(&io.xs[32 * k .. 32 * (k + 1)]);
        let x: Option<Scalar> = Scalar::from_canonical_bytes(*repr).into();
        inputs.push(SpendIn { index, x: x? });
    }
    let out = prove_spend(&handle.tree, &handle.notes, &inputs, io.digest, io.anchor, io.threads).ok()?;
    let mut records = Vec::with_capacity(n * RECORD_BYTES);
    for r in &out.records {
        records.extend_from_slice(r);
    }
    let mut t = Zeroizing::new(Vec::with_capacity(32 * n));
    for s in &out.t {
        t.extend_from_slice(&s[..]);
    }
    Some(Proven { fs1: out.fs1, records, t })
}

pub fn verify_bytes(fs1: &[u8], records: &[u8], root: &[u8; 32], digest: &[u8; 32], anchor: u64) -> bool {
    if records.is_empty() || records.len() % RECORD_BYTES != 0 || records.len() / RECORD_BYTES > INPUT_MAX {
        return false;
    }
    let list: Vec<[u8; RECORD_BYTES]> =
        records.chunks_exact(RECORD_BYTES).map(|c| c.try_into().expect("record bytes")).collect();
    verify_spend(fs1, &list, root, digest, anchor).is_ok()
}

fn arr32(ptr: *const u8) -> Option<[u8; 32]> {
    let s = slice(ptr, 32)?;
    if ptr.is_null() {
        return None;
    }
    s.try_into().ok()
}

fn put(out: *mut u8, cap: usize, bytes: &[u8]) -> bool {
    if out.is_null() || cap < bytes.len() {
        return false;
    }
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    true
}

/// Most `fs1` blob bytes for `n` inputs. 0 when `n` is outside 1..=8.
#[no_mangle]
pub extern "C" fn shear_fs1_blob_cap(n: u32) -> u32 {
    spend_blob_len(n as usize).map(|l| l as u32).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn shear_fs1_record_bytes() -> u32 {
    RECORD_BYTES as u32
}

/// FS-1 root of `count` notes. 0 when a note is not a leaf or `count` is 0.
#[no_mangle]
pub extern "C" fn shear_fs1_root(notes: *const u8, count: u64, out: *mut u8) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(bytes) = usize::try_from(count).ok().and_then(|c| slice(notes, c.checked_mul(NOTE_BYTES)?)) else {
            return BAD;
        };
        let Some(list) = notes_from(bytes) else { return BAD };
        if list.is_empty() {
            return BAD;
        }
        let Ok(tree) = tree_of_notes(&list) else { return BAD };
        if put(out, 32, &tree.root_bytes()) { OK } else { BAD }
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_fs1_tree_new() -> *mut Fs1Handle {
    catch_unwind(|| Fs1Handle::new().map(|h| Box::into_raw(Box::new(h))).unwrap_or(std::ptr::null_mut()))
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn shear_fs1_tree_free(handle: *mut Fs1Handle) {
    if !handle.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(unsafe { Box::from_raw(handle) })));
    }
}

#[no_mangle]
pub extern "C" fn shear_fs1_tree_len(handle: *const Fs1Handle) -> u64 {
    if handle.is_null() {
        return 0;
    }
    catch_unwind(AssertUnwindSafe(|| unsafe { &*handle }.len())).unwrap_or(0)
}

/// Append notes in chain order. On 0 the tree is unchanged.
#[no_mangle]
pub extern "C" fn shear_fs1_tree_append(handle: *mut Fs1Handle, notes: *const u8, count: u64) -> i32 {
    if handle.is_null() {
        return BAD;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let Some(bytes) = usize::try_from(count).ok().and_then(|c| slice(notes, c.checked_mul(NOTE_BYTES)?)) else {
            return BAD;
        };
        let Some(list) = notes_from(bytes) else { return BAD };
        if unsafe { &mut *handle }.append(&list) { OK } else { BAD }
    }))
    .unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_fs1_tree_truncate(handle: *mut Fs1Handle, len: u64) -> i32 {
    if handle.is_null() {
        return BAD;
    }
    catch_unwind(AssertUnwindSafe(|| if unsafe { &mut *handle }.truncate(len) { OK } else { BAD })).unwrap_or(BAD)
}

#[no_mangle]
pub extern "C" fn shear_fs1_tree_root(handle: *const Fs1Handle, out: *mut u8) -> i32 {
    if handle.is_null() {
        return BAD;
    }
    catch_unwind(AssertUnwindSafe(|| match unsafe { &*handle }.root() {
        Some(root) if put(out, 32, &root) => OK,
        _ => BAD,
    }))
    .unwrap_or(BAD)
}

/// Prove a spend of `n` inputs against the handle's tree.
///
/// `xs` holds `n` canonical admit scalars, `indices` their leaf indices.
/// Writes the blob to `out_fs1` (its length to `out_fs1_len`), `n` records of
/// [`RECORD_BYTES`] to `out_records`, and `n` secret 32-byte `t` scalars to
/// `out_t`.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn shear_fs1_prove(
    handle: *const Fs1Handle,
    indices: *const u64,
    xs: *const u8,
    n: u32,
    digest: *const u8,
    anchor: u64,
    threads: u32,
    out_fs1: *mut u8,
    fs1_cap: usize,
    out_fs1_len: *mut usize,
    out_records: *mut u8,
    out_t: *mut u8,
) -> i32 {
    if handle.is_null() || out_fs1_len.is_null() || indices.is_null() {
        return BAD;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        if n == 0 || n > INPUT_MAX {
            return BAD;
        }
        let idx = unsafe { std::slice::from_raw_parts(indices, n) };
        let Some(xs) = slice(xs, 32 * n) else { return BAD };
        let Some(digest) = arr32(digest) else { return BAD };
        let threads = if threads == 0 {
            std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1)
        } else {
            threads as usize
        };
        let io = ProveIo { indices: idx, xs, digest: &digest, anchor, threads };
        let Some(out) = prove_on(unsafe { &*handle }, &io) else { return BAD };
        if !put(out_fs1, fs1_cap, &out.fs1) || !put(out_records, out.records.len(), &out.records) {
            return BAD;
        }
        if !put(out_t, out.t.len(), &out.t) {
            return BAD;
        }
        unsafe { *out_fs1_len = out.fs1.len() };
        OK
    }))
    .unwrap_or(BAD)
}

/// Prove a claim spend. `null_bases` is `n` 32-byte epoch bases. `out_link` receives
/// `n` records of 96 bytes: announcement || tag-blind response || nullifier point.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn shear_fs1_prove_unlinked(
    handle: *const Fs1Handle,
    indices: *const u64,
    xs: *const u8,
    n: u32,
    digest: *const u8,
    anchor: u64,
    threads: u32,
    null_bases: *const u8,
    out_fs1: *mut u8,
    fs1_cap: usize,
    out_fs1_len: *mut usize,
    out_records: *mut u8,
    out_t: *mut u8,
    out_link: *mut u8,
) -> i32 {
    if handle.is_null() || out_fs1_len.is_null() || indices.is_null() {
        return BAD;
    }
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        if n == 0 || n > INPUT_MAX {
            return BAD;
        }
        let idx = unsafe { std::slice::from_raw_parts(indices, n) };
        let Some(xs) = slice(xs, 32 * n) else { return BAD };
        let Some(bases) = slice(null_bases, 32 * n) else { return BAD };
        let Some(digest) = arr32(digest) else { return BAD };
        let threads = if threads == 0 {
            std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1)
        } else {
            threads as usize
        };
        let mut inputs = Vec::with_capacity(n);
        for (k, &index) in idx.iter().enumerate() {
            let mut repr = Zeroizing::new([0u8; 32]);
            repr.copy_from_slice(&xs[32 * k .. 32 * (k + 1)]);
            let x: Option<Scalar> = Scalar::from_canonical_bytes(*repr).into();
            let Some(x) = x else { return BAD };
            inputs.push(SpendIn { index, x });
        }
        let mut base_list = Vec::with_capacity(n);
        for chunk in bases.chunks_exact(32) {
            let mut one = [0u8; 32];
            one.copy_from_slice(chunk);
            base_list.push(one);
        }
        let handle = unsafe { &*handle };
        let Ok((out, links)) =
            prove_spend_unlinked(&handle.tree, &handle.notes, &inputs, &digest, anchor, threads, &base_list)
        else {
            return BAD;
        };
        let mut records = Vec::with_capacity(n * RECORD_BYTES);
        for record in &out.records {
            records.extend_from_slice(record);
        }
        let mut t_bytes = Vec::with_capacity(32 * n);
        for scalar in &out.t {
            t_bytes.extend_from_slice(&scalar[..]);
        }
        if links.len() != n || !put(out_fs1, fs1_cap, &out.fs1) || !put(out_records, records.len(), &records) {
            return BAD;
        }
        let mut link_bytes = Vec::with_capacity(96 * n);
        for link in &links {
            link_bytes.extend_from_slice(link);
        }
        if !put(out_link, link_bytes.len(), &link_bytes) || !put(out_t, t_bytes.len(), &t_bytes) {
            return BAD;
        }
        unsafe { *out_fs1_len = out.fs1.len() };
        OK
    }))
    .unwrap_or(BAD)
}

/// 1 when an unlinked claim spend verifies. `link` is `n * 96` bytes and
/// `null_bases` is `n * 32` bytes.
#[no_mangle]
pub extern "C" fn shear_fs1_verify_unlinked(
    fs1: *const u8,
    fs1_len: usize,
    records: *const u8,
    n: u32,
    link: *const u8,
    root: *const u8,
    digest: *const u8,
    anchor: u64,
    null_bases: *const u8,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        if n == 0 || n > INPUT_MAX {
            return BAD;
        }
        let (Some(fs1), Some(records), Some(link), Some(root), Some(digest), Some(bases)) = (
            slice(fs1, fs1_len),
            slice(records, n * RECORD_BYTES),
            slice(link, n * 96),
            arr32(root),
            arr32(digest),
            slice(null_bases, n * 32),
        ) else {
            return BAD;
        };
        let list: Vec<[u8; RECORD_BYTES]> =
            records.chunks_exact(RECORD_BYTES).map(|c| c.try_into().expect("record bytes")).collect();
        let links: Vec<[u8; 96]> = link.chunks_exact(96).map(|c| c.try_into().expect("link bytes")).collect();
        let base_list: Vec<[u8; 32]> = bases.chunks_exact(32).map(|c| c.try_into().expect("base")).collect();
        if verify_spend_unlinked(&fs1, &list, &links, &root, &digest, anchor, &base_list).is_ok() { OK } else { BAD }
    }))
    .unwrap_or(BAD)
}

/// 1 when the blob and `n` records verify against `root` for `digest` and `anchor`.
#[no_mangle]
pub extern "C" fn shear_fs1_verify(
    fs1: *const u8,
    fs1_len: usize,
    records: *const u8,
    n: u32,
    root: *const u8,
    digest: *const u8,
    anchor: u64,
) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        if n == 0 || n > INPUT_MAX {
            return BAD;
        }
        let (Some(fs1), Some(records), Some(root), Some(digest)) =
            (slice(fs1, fs1_len), slice(records, n * RECORD_BYTES), arr32(root), arr32(digest))
        else {
            return BAD;
        };
        if verify_bytes(fs1, records, &root, &digest, anchor) { OK } else { BAD }
    }))
    .unwrap_or(BAD)
}


// ---------------------------------------------------------------------------
// External signer (Ledger) split, docs/LEDGER-VORTICE.md §5. Prover side only:
// the verifier and the posted bytes are those of shear_fs1_prove.

/// Host half of an externally signed spend, waiting for its SA+L replies.
pub struct Fs1External {
    spend: ExternalSpend,
}

/// Prove membership for `n` inputs without their admit secrets. `tags` holds
/// `n` 32-byte spend tags from the signer. Writes `n` requests of
/// [`SAL_REQUEST_BYTES`] to `out_requests` (they hold host blinds, not the
/// owner's key) and returns a context for [`shear_fs1_external_assemble`].
/// Null on failure.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn shear_fs1_prove_external(
    handle: *const Fs1Handle,
    indices: *const u64,
    tags: *const u8,
    n: u32,
    digest: *const u8,
    anchor: u64,
    threads: u32,
    out_requests: *mut u8,
) -> *mut Fs1External {
    if handle.is_null() || indices.is_null() || out_requests.is_null() {
        return std::ptr::null_mut();
    }
    catch_unwind(AssertUnwindSafe(|| {
        let n = n as usize;
        if n == 0 || n > INPUT_MAX {
            return std::ptr::null_mut();
        }
        let idx = unsafe { std::slice::from_raw_parts(indices, n) };
        let Some(tags) = slice(tags, 32 * n) else { return std::ptr::null_mut() };
        let Some(digest) = arr32(digest) else { return std::ptr::null_mut() };
        let threads = if threads == 0 {
            std::thread::available_parallelism().map(|p| p.get()).unwrap_or(1)
        } else {
            threads as usize
        };
        let inputs: Vec<ExternalIn> = (0 .. n)
            .map(|k| ExternalIn { index: idx[k], tag: tags[32 * k .. 32 * (k + 1)].try_into().expect("32") })
            .collect();
        let h = unsafe { &*handle };
        let Ok(spend) = prove_spend_external(&h.tree, &h.notes, &inputs, &digest, anchor, threads) else {
            return std::ptr::null_mut();
        };
        let mut wire = Zeroizing::new(Vec::with_capacity(n * SAL_REQUEST_BYTES));
        for r in &spend.requests {
            wire.extend_from_slice(&r.to_bytes()[..]);
        }
        if !put(out_requests, wire.len(), &wire) {
            return std::ptr::null_mut();
        }
        Box::into_raw(Box::new(Fs1External { spend }))
    }))
    .unwrap_or(std::ptr::null_mut())
}

/// Check `n` SA+L replies of [`SAL_BYTES`] and write the posted blob,
/// records and secret `t`, exactly as [`shear_fs1_prove`] does. Consumes and
/// frees `ctx` whether or not it succeeds.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub extern "C" fn shear_fs1_external_assemble(
    ctx: *mut Fs1External,
    sals: *const u8,
    n: u32,
    out_fs1: *mut u8,
    fs1_cap: usize,
    out_fs1_len: *mut usize,
    out_records: *mut u8,
    out_t: *mut u8,
) -> i32 {
    if ctx.is_null() {
        return BAD;
    }
    let ext = unsafe { Box::from_raw(ctx) };
    if out_fs1_len.is_null() {
        return BAD;
    }
    catch_unwind(AssertUnwindSafe(move || {
        let n = n as usize;
        if n == 0 || n != ext.spend.requests.len() {
            return BAD;
        }
        let Some(raw) = slice(sals, SAL_BYTES * n) else { return BAD };
        let list: Vec<[u8; SAL_BYTES]> = raw.chunks_exact(SAL_BYTES).map(|c| c.try_into().expect("sal")).collect();
        let Ok(out) = assemble_external(ext.spend, &list) else { return BAD };
        let mut records = Vec::with_capacity(n * RECORD_BYTES);
        for r in &out.records {
            records.extend_from_slice(r);
        }
        let mut t = Zeroizing::new(Vec::with_capacity(32 * n));
        for s in &out.t {
            t.extend_from_slice(&s[..]);
        }
        if !put(out_fs1, fs1_cap, &out.fs1) || !put(out_records, records.len(), &records) || !put(out_t, t.len(), &t) {
            return BAD;
        }
        unsafe { *out_fs1_len = out.fs1.len() };
        OK
    }))
    .unwrap_or(BAD)
}

/// Drop a context that will not be assembled (the user refused on the device).
#[no_mangle]
pub extern "C" fn shear_fs1_external_free(ctx: *mut Fs1External) {
    if !ctx.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(unsafe { Box::from_raw(ctx) })));
    }
}

/// Reference signer for tests and the device app's vectors: tag (32) for a
/// canonical `x`. A wallet never calls this for a Ledger account.
#[no_mangle]
pub extern "C" fn shear_fs1_external_tag(x: *const u8, out_tag: *mut u8) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(xb) = arr32(x).map(Zeroizing::new) else { return BAD };
        let x: Option<Scalar> = Scalar::from_canonical_bytes(*xb).into();
        let Some(x) = x else { return BAD };
        if put(out_tag, 32, &external_tag(&x)) { OK } else { BAD }
    }))
    .unwrap_or(BAD)
}

/// Reference signer: SA+L (160) for one request and a canonical `x`.
#[no_mangle]
pub extern "C" fn shear_fs1_external_sign(request: *const u8, x: *const u8, out_sal: *mut u8) -> i32 {
    catch_unwind(AssertUnwindSafe(|| {
        let Some(req) = slice(request, SAL_REQUEST_BYTES).and_then(SalRequest::from_bytes) else { return BAD };
        let Some(xb) = arr32(x).map(Zeroizing::new) else { return BAD };
        let x: Option<Scalar> = Scalar::from_canonical_bytes(*xb).into();
        let Some(x) = x else { return BAD };
        let Ok(sal) = sal_sign_external(&req, &x) else { return BAD };
        if put(out_sal, SAL_BYTES, &sal) { OK } else { BAD }
    }))
    .unwrap_or(BAD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::constants::RISTRETTO_BASEPOINT_POINT as G;

    #[test]
    #[cfg_attr(debug_assertions, ignore = "release only")]
    fn handle_proves_and_verifies() {
        let h = shear_fs1::spend::note_h();
        let mut notes = Vec::new();
        let mut xs = Vec::new();
        for i in 0 .. 20u64 {
            let x = Scalar::from(1000 + i);
            xs.push(x);
            notes.push(ChainNote {
                admit_pub: (G * x).compress().to_bytes(),
                commit: (G * Scalar::from(i) + h * Scalar::from(7 + i)).compress().to_bytes(),
            });
        }
        let mut handle = Fs1Handle::new().unwrap();
        assert!(handle.append(&notes[.. 12]));
        assert!(handle.append(&notes[12 ..]));
        let root20 = handle.root().unwrap();
        assert_eq!(root20, tree_of_notes(&notes).unwrap().root_bytes());
        assert!(handle.truncate(9));
        assert_eq!(handle.root().unwrap(), tree_of_notes(&notes[.. 9]).unwrap().root_bytes());
        assert!(handle.append(&notes[9 ..]));
        assert_eq!(handle.root().unwrap(), root20);

        let digest = [5u8; 32];
        let mut x_bytes = Vec::new();
        x_bytes.extend_from_slice(xs[4].as_bytes());
        x_bytes.extend_from_slice(xs[17].as_bytes());
        let out = prove_on(&handle, &ProveIo { indices: &[4, 17], xs: &x_bytes, digest: &digest, anchor: 16, threads: 2 })
            .unwrap();
        assert!(verify_bytes(&out.fs1, &out.records, &root20, &digest, 16));
        assert!(!verify_bytes(&out.fs1, &out.records, &root20, &digest, 24));
        assert!(!verify_bytes(&out.fs1, &out.records[.. RECORD_BYTES], &root20, &digest, 16));
    }
}
