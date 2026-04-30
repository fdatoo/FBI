-module(fbi_time).
-export([now_ms/0, parse_iso8601_ms/1, to_dynamic/1]).

%% Coerce any Gleam value to gleam/dynamic.Dynamic (identity cast).
to_dynamic(X) -> X.

now_ms() -> erlang:system_time(millisecond).

% Parse an ISO 8601 UTC string like "2026-04-22T18:00:00Z" into Unix milliseconds.
% Returns {ok, Ms} | {error, Reason}.
parse_iso8601_ms(Iso) ->
    Str = binary_to_list(Iso),
    case catch parse_iso_str(Str) of
        {'EXIT', _} -> {error, <<"parse error">>};
        {ok, Ms}    -> {ok, Ms};
        {error, R}  -> {error, R}
    end.

parse_iso_str(Str) ->
    % "2026-04-22T18:00:00Z" or "2026-04-22T18:00:00+00:00"
    case string:tokens(Str, "T") of
        [Date, TimeZ] ->
            [Y, Mo, D] = [list_to_integer(X) || X <- string:tokens(Date, "-")],
            % Strip timezone suffix
            Time = string:trim(TimeZ, trailing, "Z+0123456789:-"),
            TimeParts = string:tokens(Time, ":"),
            [H, Mi, S] = case TimeParts of
                [HH, MM, SS] -> [list_to_integer(HH), list_to_integer(MM), trunc(float(list_to_integer(SS)))];
                [HH, MM]     -> [list_to_integer(HH), list_to_integer(MM), 0];
                [HH]         -> [list_to_integer(HH), 0, 0];
                _            -> [0, 0, 0]
            end,
            Seconds = calendar:datetime_to_gregorian_seconds({{Y, Mo, D}, {H, Mi, S}})
                      - calendar:datetime_to_gregorian_seconds({{1970, 1, 1}, {0, 0, 0}}),
            {ok, Seconds * 1000};
        _ ->
            {error, <<"bad format">>}
    end.
