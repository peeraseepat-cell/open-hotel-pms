\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$ begin if not coalesce(value,false) then raise exception 'Assertion failed: %',message; end if; end $$;
insert into auth.users(id) values('82200000-0000-4000-8000-000000000001');
select min(id) as linen_id from public.linen_items \gset
insert into public.laundry_batches(id,business_date,pickup_round,status) values
 ('82200000-0000-4000-8000-000000000002','2312-01-01',1,'fo_dirty_counted'),
 ('82200000-0000-4000-8000-000000000003','2312-01-02',1,'fo_dirty_counted');
insert into public.laundry_batch_items(id,batch_id,linen_item_id,sent_by_hotel,estimated_qty) values
 ('82200000-0000-4000-8000-000000000004','82200000-0000-4000-8000-000000000002',:linen_id,5,5);
-- A foreign-key failure after deletion and the first insertion must roll back.
do $$ begin
 begin
 perform public.fn_laundry_replace_dirty_items('82200000-0000-4000-8000-000000000002',jsonb_build_array(jsonb_build_object('linen_item_id',(select min(id) from public.linen_items),'sent_by_hotel',9,'estimated_qty',9),jsonb_build_object('linen_item_id',2147483647,'sent_by_hotel',1,'estimated_qty',1)));
 raise exception 'Expected foreign key violation';
 exception when foreign_key_violation then null;
 end;
end $$;
select pg_temp.assert_true((select sent_by_hotel=5 from public.laundry_batch_items where id='82200000-0000-4000-8000-000000000004'),'failed dirty insertion preserves original row');
select public.fn_laundry_replace_dirty_items('82200000-0000-4000-8000-000000000002',jsonb_build_array(jsonb_build_object('linen_item_id',:linen_id,'sent_by_hotel',5,'estimated_qty',5)),jsonb_build_array(jsonb_build_object('linen_item_id',:linen_id,'qty',1,'photo_keys',jsonb_build_array('rewash/linen/fixture.jpg'))),'82200000-0000-4000-8000-000000000001');
select public.fn_laundry_replace_dirty_items('82200000-0000-4000-8000-000000000002',jsonb_build_array(jsonb_build_object('linen_item_id',:linen_id,'sent_by_hotel',5,'estimated_qty',5)),jsonb_build_array(jsonb_build_object('linen_item_id',:linen_id,'qty',1,'photo_keys',jsonb_build_array('rewash/linen/fixture.jpg'))),'82200000-0000-4000-8000-000000000001');
select pg_temp.assert_true((select count(*)=1 from public.laundry_rewash_events where sent_in_batch_id='82200000-0000-4000-8000-000000000002'),'retry does not duplicate dirty rewash');
select id as rewash_id from public.laundry_rewash_events where sent_in_batch_id='82200000-0000-4000-8000-000000000002' \gset
select public.fn_laundry_apply_return_step('82200000-0000-4000-8000-000000000003',jsonb_build_object('return_items',jsonb_build_array(jsonb_build_object('source_batch_id','82200000-0000-4000-8000-000000000002','linen_item_id',:linen_id,'received_qty',2)),'rewash_resolved',jsonb_build_array(jsonb_build_object('rewash_event_id',:rewash_id,'resolved_qty',1)))) as result \gset
select pg_temp.assert_true((select status='resolved' and photo_keys=array['rewash/linen/fixture.jpg'] from public.laundry_rewash_events where id=:rewash_id),'committed receive retains photo keys for deletion acknowledgement');
select pg_temp.assert_true((:'result'::jsonb->'photo_cleanup') @> jsonb_build_array(jsonb_build_object('rewash_event_id',:rewash_id,'key','rewash/linen/fixture.jpg')),'committed receive returns durable photo cleanup handoff');
select pg_temp.assert_true((select received_back=2 from public.laundry_batch_items where batch_id='82200000-0000-4000-8000-000000000002'),'successful receive advances source quantities');
select pg_temp.assert_true(not has_function_privilege('anon','public.fn_laundry_apply_return_step(uuid,jsonb,text)','EXECUTE') and not has_function_privilege('authenticated','public.fn_laundry_apply_return_step(uuid,jsonb,text)','EXECUTE'),'receive mutation remains service only');
select pg_temp.assert_true(not has_function_privilege('anon','public.fn_laundry_replace_dirty_items(uuid,jsonb,jsonb,uuid,boolean)','EXECUTE') and not has_function_privilege('authenticated','public.fn_laundry_replace_dirty_items(uuid,jsonb,jsonb,uuid,boolean)','EXECUTE'),'dirty mutation remains service only');
rollback;
