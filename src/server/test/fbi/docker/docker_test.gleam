import envoy
import fbi/docker
import gleeunit/should

pub fn ping_test() {
  // Only run if DOCKER_TEST env var is set
  case envoy.get("DOCKER_TEST") {
    Error(_) -> Nil
    Ok(_) -> {
      let assert Ok(sock) = docker.connect("/var/run/docker.sock")
      let assert Ok(#(status, _)) =
        docker.request(sock, "GET", "/_ping", <<>>, "text/plain")
      docker.close(sock)
      status |> should.equal(200)
    }
  }
}
