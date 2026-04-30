import fbi/docker/tar
import gleam/bit_array
import gleam/dict
import gleeunit/should

pub fn build_simple_archive_test() {
  let files = dict.from_list([#("hello.txt", bit_array.from_string("world"))])
  let archive = tar.build(files)
  // USTAR archive: header(512) + content rounded to 512-block + 2x trailer(512)
  // "world" is 5 bytes, padded to 512
  bit_array.byte_size(archive) |> should.equal(512 + 512 + 1024)
}

pub fn header_has_filename_test() {
  let files = dict.from_list([#("test.txt", bit_array.from_string("x"))])
  let archive = tar.build(files)
  // First 8 bytes of header should be "test.txt"
  let assert Ok(name_bits) = bit_array.slice(archive, 0, 8)
  bit_array.to_string(name_bits) |> should.equal(Ok("test.txt"))
}
