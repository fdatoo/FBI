-module(fbi_file_writer).
-export([open/1, append/2, close/1]).

open(Path) when is_binary(Path) ->
    PathStr = binary_to_list(Path),
    case file:open(PathStr, [append, raw, binary]) of
        {ok, IoDevice} -> {ok, IoDevice};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

append(IoDevice, Data) ->
    case file:write(IoDevice, Data) of
        ok -> {ok, nil};
        {error, Reason} -> {error, atom_to_binary(Reason, utf8)}
    end.

close(IoDevice) -> file:close(IoDevice), nil.
