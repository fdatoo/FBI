-module('Elixir.FBI.Terminal').
-export([new/2, feed/2, snapshot/1, snapshot_at/2, resize/3]).
-on_load(load/0).

load() ->
    PrivDir = case code:priv_dir(fbi) of
        {error, _} ->
            %% Fallback for development: look relative to this file's directory
            filename:join([filename:dirname(code:which(?MODULE)), "..", "priv"]);
        Dir -> Dir
    end,
    Path = filename:join(PrivDir, "native/fbi_term_core"),
    erlang:load_nif(Path, 0).

new(_Cols, _Rows) -> erlang:nif_error(nif_not_loaded).
feed(_Handle, _Bytes) -> erlang:nif_error(nif_not_loaded).
snapshot(_Handle) -> erlang:nif_error(nif_not_loaded).
snapshot_at(_Handle, _Offset) -> erlang:nif_error(nif_not_loaded).
resize(_Handle, _Cols, _Rows) -> erlang:nif_error(nif_not_loaded).
