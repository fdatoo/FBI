import gleam/bit_array

pub type CryptoError {
  DecryptionFailed
  InvalidKeyLength
}

pub fn encrypt(
  key: BitArray,
  plaintext: BitArray,
) -> Result(BitArray, CryptoError) {
  case bit_array.byte_size(key) {
    32 -> fbi_crypto_encrypt(key, plaintext, <<>>)
    _ -> Error(InvalidKeyLength)
  }
}

pub fn decrypt(key: BitArray, blob: BitArray) -> Result(BitArray, CryptoError) {
  case bit_array.byte_size(key) {
    32 -> fbi_crypto_decrypt(key, blob, <<>>)
    _ -> Error(InvalidKeyLength)
  }
}

@external(erlang, "fbi_crypto", "encrypt")
fn fbi_crypto_encrypt(
  key: BitArray,
  plaintext: BitArray,
  aad: BitArray,
) -> Result(BitArray, CryptoError)

@external(erlang, "fbi_crypto", "decrypt")
fn fbi_crypto_decrypt(
  key: BitArray,
  blob: BitArray,
  aad: BitArray,
) -> Result(BitArray, CryptoError)
