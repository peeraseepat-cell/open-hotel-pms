CREATE TABLE IF NOT EXISTS public.rate_plan_tiers (
  rate_plan_id uuid NOT NULL REFERENCES public.rate_plans(id) ON DELETE CASCADE,
  tier_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_plan_id, tier_code),
  CONSTRAINT chk_rate_plan_tiers_code CHECK (tier_code IN ('loyal', 'vip', 'longest'))
);

CREATE INDEX IF NOT EXISTS idx_rate_plan_tiers_tier_code
  ON public.rate_plan_tiers (tier_code, rate_plan_id);

CREATE TABLE IF NOT EXISTS public.rate_plan_profiles (
  rate_plan_id uuid NOT NULL REFERENCES public.rate_plans(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES public.guest_profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rate_plan_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_rate_plan_profiles_profile_id
  ON public.rate_plan_profiles (profile_id, rate_plan_id);
