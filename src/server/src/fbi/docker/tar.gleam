import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/int
import gleam/list

pub fn build(files: Dict(String, BitArray)) -> BitArray {
  let entries =
    dict.to_list(files)
    |> list.map(fn(pair) { entry(pair.0, pair.1) })
  let all_entries = bit_array.concat(entries)
  // Two 512-byte zero blocks signal end of archive
  let trailer = <<0:size(8192)>>
  bit_array.append(all_entries, trailer)
}

fn entry(path: String, content: BitArray) -> BitArray {
  let header = build_header(path, bit_array.byte_size(content))
  let padded = pad_to_block(content)
  bit_array.concat([header, padded])
}

fn build_header(path: String, size: Int) -> BitArray {
  let name_field = pad_string(path, 100)
  let mode_field = pad_string("0000644", 8)
  let uid_field = pad_string("0000000", 8)
  let gid_field = pad_string("0000000", 8)
  let size_str = int_to_octal(size)
  let size_field = pad_string(size_str, 12)
  let mtime_field = pad_string("00000000000", 12)
  let chksum_placeholder = <<"        ":utf8>>
  // 8 spaces
  let typeflag = <<"0":utf8>>
  let linkname = pad_string("", 100)
  let magic = <<"ustar\u{0000}":utf8>>
  // 6 bytes: "ustar" + null
  let version = <<"00":utf8>>
  let uname = pad_string("root", 32)
  let gname = pad_string("root", 32)
  let devmajor = pad_string("0000000", 8)
  let devminor = pad_string("0000000", 8)
  let prefix = pad_string("", 155)
  // USTAR header fields total 500 bytes, pad to 512
  let trailing = <<0:size(96)>>

  let pre =
    bit_array.concat([
      name_field,
      mode_field,
      uid_field,
      gid_field,
      size_field,
      mtime_field,
    ])
  let post =
    bit_array.concat([
      typeflag,
      linkname,
      magic,
      version,
      uname,
      gname,
      devmajor,
      devminor,
      prefix,
      trailing,
    ])

  let header_without_checksum =
    bit_array.concat([pre, chksum_placeholder, post])
  let chksum = checksum(header_without_checksum)
  let chksum_str = int_to_octal(chksum) <> "\u{0000} "
  let chksum_field = pad_string(chksum_str, 8)

  bit_array.concat([pre, chksum_field, post])
}

fn checksum(header: BitArray) -> Int {
  to_bytes(header) |> list.fold(0, fn(acc, b) { acc + b })
}

fn to_bytes(b: BitArray) -> List(Int) {
  to_bytes_loop(b, []) |> list.reverse()
}

fn to_bytes_loop(b: BitArray, acc: List(Int)) -> List(Int) {
  case b {
    <<byte, rest:bytes>> -> to_bytes_loop(rest, [byte, ..acc])
    _ -> acc
  }
}

fn pad_string(s: String, n: Int) -> BitArray {
  let bits = bit_array.from_string(s)
  let len = bit_array.byte_size(bits)
  case len >= n {
    True -> {
      let assert Ok(truncated) = bit_array.slice(bits, 0, n)
      truncated
    }
    False -> {
      let pad_bits = { n - len } * 8
      let padding = <<0:size(pad_bits)>>
      bit_array.append(bits, padding)
    }
  }
}

fn pad_to_block(content: BitArray) -> BitArray {
  let len = bit_array.byte_size(content)
  let remainder = len % 512
  case remainder {
    0 -> content
    _ -> {
      let pad_bits = { 512 - remainder } * 8
      bit_array.append(content, <<0:size(pad_bits)>>)
    }
  }
}

fn int_to_octal(n: Int) -> String {
  let assert Ok(s) = int.to_base_string(n, 8)
  s
}
