-module(fbi_term_nif).
-export([new_state/2, feed/2, snapshot/1, snapshot_at/2, resize/3, feed_file/2]).

new_state(Cols, Rows) ->
    'Elixir.FBI.Terminal':new(Cols, Rows).

feed(Handle, Bytes) ->
    'Elixir.FBI.Terminal':feed(Handle, Bytes).

%% NIF returns a NifStruct (Elixir struct map):
%%   #{'__struct__' => 'Elixir.FBI.Terminal.Snapshot',
%%     ansi => Binary, cols => Int, rows => Int, byte_offset => Int}
%% Gleam wrapper expects tuple: {AnsiString, Cols, Rows, ByteOffset}
snapshot(Handle) ->
    case 'Elixir.FBI.Terminal':snapshot(Handle) of
        #{'__struct__' := 'Elixir.FBI.Terminal.Snapshot',
          ansi := Ansi, cols := Cols, rows := Rows, byte_offset := ByteOffset} ->
            {unicode:characters_to_binary(Ansi, utf8), Cols, Rows, ByteOffset};
        Other -> Other
    end.

%% NIF returns a NifStruct: #{'__struct__' => 'Elixir.FBI.Terminal.ModePrefix', ansi => Binary}
%% Gleam wrapper expects a String (binary)
snapshot_at(Handle, Offset) ->
    case 'Elixir.FBI.Terminal':snapshot_at(Handle, Offset) of
        #{'__struct__' := 'Elixir.FBI.Terminal.ModePrefix', ansi := Ansi} ->
            unicode:characters_to_binary(Ansi, utf8);
        Other -> Other
    end.

resize(Handle, Cols, Rows) ->
    'Elixir.FBI.Terminal':resize(Handle, Cols, Rows).

feed_file(Handle, Path) ->
    case file:read_file(Path) of
        {ok, <<>>} -> ok;
        {ok, Bytes} -> feed(Handle, Bytes);
        {error, enoent} -> ok;
        {error, Reason} -> {error, Reason}
    end.
