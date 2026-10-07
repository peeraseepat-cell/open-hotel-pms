begin;

-- Hotfix defaults for maid collection scope:
-- keep only Pillow, Towel, Kettle as HK collect for now.
update public.loan_items
set requires_hk_collection = true
where code in ('EXTRA_PILLOW', 'EXTRA_TOWEL', 'KETTLE');

update public.loan_items
set requires_hk_collection = false
where code = 'EXTRA_BED';

commit;
