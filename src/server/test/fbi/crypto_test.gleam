import fbi/crypto
import gleeunit/should

pub fn round_trip_test() {
  let key = <<
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  >>
  let plaintext = <<"hello world":utf8>>
  let assert Ok(ciphertext) = crypto.encrypt(key, plaintext)
  let assert Ok(decrypted) = crypto.decrypt(key, ciphertext)
  decrypted |> should.equal(plaintext)
}

pub fn wrong_key_fails_test() {
  let key = <<
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  >>
  let wrong_key = <<
    255, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
    21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  >>
  let plaintext = <<"secret":utf8>>
  let assert Ok(ciphertext) = crypto.encrypt(key, plaintext)
  crypto.decrypt(wrong_key, ciphertext) |> should.be_error()
}
