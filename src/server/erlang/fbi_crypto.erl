-module(fbi_crypto).
-export([encrypt/3, decrypt/3]).

%% encrypt(Key, PlainText, AAD) -> {ok, <<IV(12), CipherText, Tag(16)>>}
encrypt(Key, PlainText, AAD) ->
    IV = crypto:strong_rand_bytes(12),
    {CipherText, Tag} = crypto:crypto_one_time_aead(aes_256_gcm, Key, IV, PlainText, AAD, 16, true),
    {ok, <<IV:12/binary, CipherText/binary, Tag:16/binary>>}.

%% decrypt(Key, Blob, AAD) -> {ok, PlainText} | {error, decryption_failed}
decrypt(Key, Blob, AAD) ->
    IVSize = 12,
    TagSize = 16,
    BlobSize = byte_size(Blob),
    CipherSize = BlobSize - IVSize - TagSize,
    <<IV:IVSize/binary, CipherText:CipherSize/binary, Tag:TagSize/binary>> = Blob,
    case crypto:crypto_one_time_aead(aes_256_gcm, Key, IV, CipherText, AAD, Tag, false) of
        error     -> {error, decryption_failed};
        PlainText -> {ok, PlainText}
    end.
