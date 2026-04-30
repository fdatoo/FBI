import fbi/config
import gleeunit/should

pub fn load_uses_defaults_test() {
  // PORT defaults to 3000 when unset
  let result = config.env_int("FBI_TEST_NONEXISTENT_PORT_VAR", 3000)
  result |> should.equal(Ok(3000))
}

pub fn load_required_missing_test() {
  let result = config.env_required("FBI_TEST_NONEXISTENT_REQUIRED_VAR")
  result |> should.be_error()
}
