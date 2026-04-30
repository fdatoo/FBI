import fbi/run/broadcaster
import fbi/run/types.{AgentStatusChanged, RunOutcome, Starting}
import gleam/option.{None}
import gleeunit/should

pub fn phase_constructable_test() {
  let assert Ok(bc) = broadcaster.start()
  let phase = Starting(bc)
  let Starting(_) = phase
}

pub fn agent_status_changed_constructable_test() {
  let msg = AgentStatusChanged("waiting")
  let AgentStatusChanged(status) = msg
  status |> should.equal("waiting")
}

pub fn run_outcome_test() {
  let outcome =
    RunOutcome(
      exit_code: 0,
      branch_pushed: None,
      head_commit: None,
      title: None,
      error_message: None,
      claude_session_id: None,
    )
  outcome.exit_code |> should.equal(0)
}
