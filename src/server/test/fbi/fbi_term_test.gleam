import fbi/fbi_term
import gleeunit/should

pub fn round_trip_test() {
  let term = fbi_term.new(80, 24)
  let term2 = fbi_term.feed(term, <<"hello":utf8>>)
  let snap = fbi_term.snapshot(term2)
  snap.cols |> should.equal(80)
  snap.rows |> should.equal(24)
  snap.byte_offset |> should.equal(5)
}

pub fn resize_test() {
  let term = fbi_term.new(80, 24)
  let term2 = fbi_term.resize(term, 100, 30)
  let snap = fbi_term.snapshot(term2)
  snap.cols |> should.equal(100)
  snap.rows |> should.equal(30)
}
