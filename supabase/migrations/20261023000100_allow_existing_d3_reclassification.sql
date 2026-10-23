ALTER TABLE public.recruiting_universities DROP CONSTRAINT recruiting_universities_division_check;
ALTER TABLE public.recruiting_universities ADD CONSTRAINT recruiting_universities_division_check CHECK (division IN ('NCAA D1','NCAA D2','NCAA D3','NAIA'));
