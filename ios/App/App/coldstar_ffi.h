// coldstar_ffi.h — C-ABI for the Coldstar Rust core (hand-written from lib.rs).
// Bridging header for the iOS app. Every call takes a JSON string and returns a
// newly-allocated JSON string that MUST be released with coldstar_free_string().
#ifndef COLDSTAR_FFI_H
#define COLDSTAR_FFI_H

#ifdef __cplusplus
extern "C" {
#endif

char *coldstar_init(const char *config_json);
char *coldstar_init_session(const char *request_json);
char *coldstar_sign(const char *request_json);
char *coldstar_get_balance(const char *request_json);
char *coldstar_check_token(const char *request_json);
char *coldstar_generate_wallet(const char *request_json);
void  coldstar_free_string(char *s);

#ifdef __cplusplus
}
#endif

#endif /* COLDSTAR_FFI_H */
