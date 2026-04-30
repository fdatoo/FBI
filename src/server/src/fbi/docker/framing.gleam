import gleam/bit_array
import gleam/int
import gleam/string

pub type ChunkResult {
  Chunk(BitArray)
  Eof
  FrameError(String)
}

/// Read one chunk from a chunked-encoded stream.
pub fn read_chunk(buffer: BitArray) -> #(ChunkResult, BitArray) {
  case parse_size_line(buffer) {
    Error(_) -> #(FrameError("invalid chunk size line"), buffer)
    Ok(#(0, _rest)) -> #(Eof, <<>>)
    Ok(#(size, rest)) -> {
      let rest_size = bit_array.byte_size(rest)
      case rest_size >= size + 2 {
        False -> #(FrameError("incomplete chunk"), buffer)
        True -> {
          let assert Ok(data) = bit_array.slice(rest, 0, size)
          let after_size = rest_size - size - 2
          let assert Ok(after) = bit_array.slice(rest, size + 2, after_size)
          #(Chunk(data), after)
        }
      }
    }
  }
}

fn parse_size_line(buffer: BitArray) -> Result(#(Int, BitArray), Nil) {
  case find_crlf(buffer, 0) {
    Error(_) -> Error(Nil)
    Ok(idx) -> {
      let assert Ok(line_bits) = bit_array.slice(buffer, 0, idx)
      case bit_array.to_string(line_bits) {
        Error(_) -> Error(Nil)
        Ok(line) -> {
          case int.base_parse(string.trim(line), 16) {
            Error(_) -> Error(Nil)
            Ok(size) -> {
              let buf_size = bit_array.byte_size(buffer)
              let assert Ok(rest) =
                bit_array.slice(buffer, idx + 2, buf_size - idx - 2)
              Ok(#(size, rest))
            }
          }
        }
      }
    }
  }
}

fn find_crlf(buffer: BitArray, offset: Int) -> Result(Int, Nil) {
  case bit_array.slice(buffer, offset, 2) {
    Ok(<<0x0d, 0x0a>>) -> Ok(offset)
    Ok(_) -> find_crlf(buffer, offset + 1)
    Error(_) -> Error(Nil)
  }
}

/// Strip Docker stdcopy framing and return concatenated payload.
pub fn unframe(buffer: BitArray) -> Result(BitArray, String) {
  unframe_loop(buffer, <<>>)
}

fn unframe_loop(buffer: BitArray, acc: BitArray) -> Result(BitArray, String) {
  case buffer {
    <<>> -> Ok(acc)
    <<_stream, _:8, _:8, _:8, size:32-big, rest:bytes>> -> {
      let rest_size = bit_array.byte_size(rest)
      case rest_size >= size {
        False -> Error("truncated docker frame")
        True -> {
          let assert Ok(payload) = bit_array.slice(rest, 0, size)
          let remaining_size = rest_size - size
          let assert Ok(remaining) = bit_array.slice(rest, size, remaining_size)
          unframe_loop(remaining, bit_array.append(acc, payload))
        }
      }
    }
    _ -> Error("invalid docker frame header")
  }
}
