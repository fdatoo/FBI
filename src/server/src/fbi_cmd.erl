-module(fbi_cmd).
-export([run/3, run_streaming/4, find_executable/1]).

%% run(Cmd :: binary(), Args :: [binary()], Env :: [{binary(), binary()}]) ->
%%     {ExitCode :: integer(), Output :: binary()}
%% Runs Cmd as a subprocess with Args and Env, capturing combined stdout+stderr.
run(Cmd, Args, Env) ->
    CmdStr = binary_to_list(Cmd),
    ArgsList = [binary_to_list(A) || A <- Args],
    EnvList = [{binary_to_list(K), binary_to_list(V)} || {K, V} <- Env],
    Port = open_port({spawn_executable, CmdStr},
                     [binary, exit_status, stderr_to_stdout,
                      {args, ArgsList}, {env, EnvList}]),
    collect(Port, <<>>).

collect(Port, Acc) ->
    receive
        {Port, {data, Chunk}} -> collect(Port, <<Acc/binary, Chunk/binary>>);
        {Port, {exit_status, Code}} -> {Code, Acc}
    end.

%% run_streaming(Cmd, Args, Env, OnChunk) ->
%%     {ExitCode :: integer(), TotalBytes :: integer()}
%% Like run/3 but invokes OnChunk(Chunk) for each output chunk as it arrives.
%% Used by image_builder for streaming `docker buildx build` progress to the
%% terminal. Does not retain the chunks — the caller is responsible for
%% accumulating them inside OnChunk if needed.
run_streaming(Cmd, Args, Env, OnChunk) ->
    CmdStr = binary_to_list(Cmd),
    ArgsList = [binary_to_list(A) || A <- Args],
    EnvList = [{binary_to_list(K), binary_to_list(V)} || {K, V} <- Env],
    Port = open_port({spawn_executable, CmdStr},
                     [binary, exit_status, stderr_to_stdout,
                      {args, ArgsList}, {env, EnvList}]),
    stream(Port, OnChunk, 0).

stream(Port, OnChunk, Total) ->
    receive
        {Port, {data, Chunk}} ->
            OnChunk(Chunk),
            stream(Port, OnChunk, Total + byte_size(Chunk));
        {Port, {exit_status, Code}} ->
            {Code, Total}
    end.

%% find_executable(Name :: binary()) -> binary()
%% Resolves a program name to its full path, or returns Name unchanged.
find_executable(Name) ->
    NameStr = binary_to_list(Name),
    case os:find_executable(NameStr) of
        false -> Name;
        Path  -> list_to_binary(Path)
    end.
