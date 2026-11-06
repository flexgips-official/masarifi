-- Only used to call the Edge Function from SQL during tests (net.http_post).
create extension if not exists pg_net with schema extensions;
