-module(fbi_term_nif).
-export([new_state/2, feed/2, snapshot/1, snapshot_at/2, resize/3, feed_file/2]).

new_state(_, _)   -> {error, nif_not_loaded}.
feed(_, _)        -> {error, nif_not_loaded}.
snapshot(_)       -> {error, nif_not_loaded}.
snapshot_at(_, _) -> {error, nif_not_loaded}.
resize(_, _, _)   -> {error, nif_not_loaded}.
feed_file(_, _)   -> {error, nif_not_loaded}.
