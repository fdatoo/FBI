-module(fbi_docker_ffi).
-export([connect_unix/1, close/1, send/2, recv/2]).

connect_unix(Path) when is_binary(Path) ->
    PathStr = binary_to_list(Path),
    case gen_tcp:connect({local, PathStr}, 0,
                         [binary, {active, false}, {packet, raw}]) of
        {ok, Sock} -> {ok, Sock};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

close(Sock) -> gen_tcp:close(Sock), nil.

send(Sock, Data) ->
    case gen_tcp:send(Sock, Data) of
        ok -> {ok, nil};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

%% recv(Sock, 0) -> receive whatever is available, with 5s timeout
recv(Sock, _Len) ->
    case gen_tcp:recv(Sock, 0, 5000) of
        {ok, Data} -> {ok, Data};
        {error, closed} -> {ok, <<>>};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.
