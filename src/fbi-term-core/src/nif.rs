use crate::parser::Parser;
use rustler::{Atom, Binary, Env, Error, NifResult, OwnedBinary, ResourceArc};
use std::sync::Mutex;

pub struct ParserResource(pub Mutex<Parser>);

mod atoms {
    rustler::atoms! { ok, error }
}

// NifStruct for Snapshot — must match FBI.Terminal.Snapshot Elixir struct fields exactly
#[derive(rustler::NifStruct)]
#[module = "FBI.Terminal.Snapshot"]
struct SnapshotNif<'a> {
    ansi: Binary<'a>,
    cols: u32,
    rows: u32,
    byte_offset: u64,
}

// NifStruct for ModePrefix — must match FBI.Terminal.ModePrefix Elixir struct fields exactly
#[derive(rustler::NifStruct)]
#[module = "FBI.Terminal.ModePrefix"]
struct ModePrefixNif<'a> {
    ansi: Binary<'a>,
}

#[rustler::nif]
fn new(cols: u32, rows: u32) -> NifResult<ResourceArc<ParserResource>> {
    if cols == 0 || rows == 0 || cols > u16::MAX as u32 || rows > u16::MAX as u32 {
        return Err(Error::BadArg);
    }
    Ok(ResourceArc::new(ParserResource(Mutex::new(Parser::new(
        cols as u16,
        rows as u16,
    )))))
}

#[rustler::nif(schedule = "DirtyIo")]
fn feed(handle: ResourceArc<ParserResource>, bytes: Binary) -> Atom {
    let mut p = handle.0.lock().unwrap();
    p.feed(bytes.as_slice());
    atoms::ok()
}

#[rustler::nif]
fn snapshot<'a>(env: Env<'a>, handle: ResourceArc<ParserResource>) -> NifResult<SnapshotNif<'a>> {
    let p = handle.0.lock().unwrap();
    let snap = p.snapshot();

    let mut bin = OwnedBinary::new(snap.ansi.len()).ok_or(Error::BadArg)?;
    bin.as_mut_slice().copy_from_slice(&snap.ansi);

    Ok(SnapshotNif {
        ansi: bin.release(env),
        cols: snap.cols as u32,
        rows: snap.rows as u32,
        byte_offset: snap.byte_offset,
    })
}

#[rustler::nif]
fn snapshot_at<'a>(
    env: Env<'a>,
    handle: ResourceArc<ParserResource>,
    offset: u64,
) -> NifResult<ModePrefixNif<'a>> {
    let p = handle.0.lock().unwrap();
    let prefix = p.snapshot_at(offset);

    let mut bin = OwnedBinary::new(prefix.ansi.len()).ok_or(Error::BadArg)?;
    bin.as_mut_slice().copy_from_slice(&prefix.ansi);

    Ok(ModePrefixNif {
        ansi: bin.release(env),
    })
}

#[rustler::nif]
fn resize(handle: ResourceArc<ParserResource>, cols: u32, rows: u32) -> NifResult<Atom> {
    if cols == 0 || rows == 0 || cols > u16::MAX as u32 || rows > u16::MAX as u32 {
        return Err(Error::BadArg);
    }
    let mut p = handle.0.lock().unwrap();
    p.resize(cols as u16, rows as u16);
    Ok(atoms::ok())
}

#[allow(non_local_definitions)]
fn on_load(env: Env, _info: rustler::Term) -> bool {
    rustler::resource!(ParserResource, env);
    true
}

rustler::init!(
    "Elixir.FBI.Terminal",
    [new, feed, snapshot, snapshot_at, resize],
    load = on_load
);
