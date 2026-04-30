-module(fbi_priv).
-export([read/1, path/1]).

%% read(RelPath :: binary()) -> {ok, binary()} | {error, binary()}
%% Reads a file from the fbi app's priv directory by name. RelPath is the
%% path under priv/ — e.g. <<"static/postbuild.sh">>. Falls back to the
%% literal path on systems where code:priv_dir/1 fails (rare; mostly when
%% the app isn't loaded yet).
read(RelPath) ->
    case file:read_file(binary_to_list(path(RelPath))) of
        {ok, Bin}        -> {ok, Bin};
        {error, Reason}  -> {error, list_to_binary(io_lib:format("~p", [Reason]))}
    end.

%% path(RelPath :: binary()) -> binary()
%% Returns the absolute path to a file under the fbi app's priv directory.
%% Falls back to the literal RelPath when code:priv_dir/1 fails.
path(RelPath) ->
    case code:priv_dir(fbi) of
        {error, _} -> RelPath;
        PrivDir    -> list_to_binary(filename:join(PrivDir, binary_to_list(RelPath)))
    end.
