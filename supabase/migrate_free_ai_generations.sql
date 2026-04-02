-- Seed configurable free AI generations limit (default: 2 to match existing 1 gen + 1 redo behavior)
insert into public.app_config (key, value)
values ('free_ai_generations', '2')
on conflict (key) do nothing;
