import fbi/run/image_gc.{GcError, GcResult}
import gleeunit/should

pub fn gc_result_zero_test() {
  let r = GcResult(deleted_count: 0, deleted_bytes: 0, errors: [])
  r.deleted_count |> should.equal(0)
  r.deleted_bytes |> should.equal(0)
  r.errors |> should.equal([])
}

pub fn gc_error_fields_test() {
  let e = GcError(tag: "fbi/p1:abc123", message: "not found")
  e.tag |> should.equal("fbi/p1:abc123")
  e.message |> should.equal("not found")
}
