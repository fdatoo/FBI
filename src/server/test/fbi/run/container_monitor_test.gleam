import fbi/run/container_monitor
import gleam/option.{None, Some}
import gleeunit/should
import simplifile

pub fn read_agent_status_returns_none_when_file_missing_test() {
  let dir = "/tmp/fbi-test-status-" <> "missing"
  container_monitor.read_agent_status(dir)
  |> should.equal(None)
}

pub fn read_agent_status_returns_trimmed_value_test() {
  let dir = "/tmp/fbi-test-status-present"
  let _ = simplifile.create_directory_all(dir)
  let _ = simplifile.write(dir <> "/agent-status", "waiting\n")
  let result = container_monitor.read_agent_status(dir)
  result |> should.equal(Some("waiting"))
  let _ = simplifile.delete(dir)
}

pub fn read_agent_status_returns_none_for_empty_file_test() {
  let dir = "/tmp/fbi-test-status-empty"
  let _ = simplifile.create_directory_all(dir)
  let _ = simplifile.write(dir <> "/agent-status", "")
  let result = container_monitor.read_agent_status(dir)
  result |> should.equal(None)
  let _ = simplifile.delete(dir)
}
