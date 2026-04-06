-- Seed configurable free AI generations limit (default: 10 free designs per event)
insert into public.app_config (key, value)
values ('free_ai_generations', '10')
on conflict (key) do nothing;
