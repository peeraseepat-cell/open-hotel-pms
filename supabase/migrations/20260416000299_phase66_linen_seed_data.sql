begin;

insert into public.linen_items (item_number, name_th, name_en, category, is_active, sort_order)
values
  (1, 'ปลอกหมอน', 'Pillowcase', 'bed', true, 1),
  (2, 'ผ้าขนหนู', 'Towel', 'bath', true, 2),
  (3, 'ผ้าเช็ดเท้า', 'Bath Mat', 'bath', true, 3),
  (4, 'ผ้าปูเล็ก', 'Single Bed Sheet', 'bed', true, 4),
  (5, 'ผ้าปูกลาง', 'Double Bed Sheet', 'bed', true, 5),
  (6, 'ผ้าปูใหญ่', 'King Bed Sheet', 'bed', true, 6),
  (7, 'ปลอกผ้านวมเล็ก', 'Single Duvet Cover', 'bed', true, 7),
  (8, 'ปลอกผ้านวมกลาง', 'Double Duvet Cover', 'bed', true, 8),
  (9, 'ปลอกผ้านวมใหญ่', 'King Duvet Cover', 'bed', true, 9),
  (10, 'รองกันเปื้อนเล็ก', 'Single Mattress Protector', 'bed', false, 10),
  (11, 'รองกันเปื้อนกลาง', 'Double Mattress Protector', 'bed', false, 11),
  (12, 'รองกันเปื้อนใหญ่', 'King Mattress Protector', 'bed', false, 12),
  (13, 'ผ้าห่มเล็ก', 'Single Blanket', 'bed', false, 13),
  (14, 'ผ้าห่มกลาง', 'Double Blanket', 'bed', false, 14),
  (15, 'ผ้าห่มใหญ่', 'King Blanket', 'bed', false, 15),
  (16, 'หมอน', 'Pillow', 'bed', false, 16)
on conflict (item_number) do update set
  name_th = excluded.name_th,
  name_en = excluded.name_en,
  category = excluded.category,
  is_active = excluded.is_active,
  sort_order = excluded.sort_order;

with setup(room_type_code, item_number, qty) as (
  values
    ('TS', 1, 2), ('TS', 2, 2), ('TS', 3, 0), ('TS', 4, 2), ('TS', 5, 0), ('TS', 6, 0), ('TS', 7, 2), ('TS', 8, 0), ('TS', 9, 0),
    ('DS', 1, 2), ('DS', 2, 2), ('DS', 3, 0), ('DS', 4, 0), ('DS', 5, 1), ('DS', 6, 0), ('DS', 7, 0), ('DS', 8, 1), ('DS', 9, 0),
    ('DQ', 1, 2), ('DQ', 2, 2), ('DQ', 3, 1), ('DQ', 4, 0), ('DQ', 5, 1), ('DQ', 6, 0), ('DQ', 7, 0), ('DQ', 8, 1), ('DQ', 9, 0),
    ('DT', 1, 2), ('DT', 2, 2), ('DT', 3, 1), ('DT', 4, 2), ('DT', 5, 0), ('DT', 6, 0), ('DT', 7, 2), ('DT', 8, 0), ('DT', 9, 0),
    ('JS', 1, 2), ('JS', 2, 2), ('JS', 3, 1), ('JS', 4, 0), ('JS', 5, 0), ('JS', 6, 1), ('JS', 7, 0), ('JS', 8, 0), ('JS', 9, 1),
    ('TB', 1, 3), ('TB', 2, 3), ('TB', 3, 1), ('TB', 4, 3), ('TB', 5, 0), ('TB', 6, 0), ('TB', 7, 3), ('TB', 8, 0), ('TB', 9, 0),
    ('FR', 1, 3), ('FR', 2, 3), ('FR', 3, 1), ('FR', 4, 1), ('FR', 5, 0), ('FR', 6, 1), ('FR', 7, 1), ('FR', 8, 0), ('FR', 9, 1)
)
insert into public.room_linen_setups (room_type_code, linen_item_id, qty)
select setup.room_type_code, li.id, setup.qty
from setup
join public.linen_items li on li.item_number = setup.item_number
where li.is_active = true
on conflict (room_type_code, linen_item_id) do update set
  qty = excluded.qty;

with setup(item_number, qty_per_room) as (
  values (1, 2), (2, 2), (5, 1)
)
insert into public.linen_dayuse_setup (linen_item_id, qty_per_room)
select li.id, setup.qty_per_room
from setup
join public.linen_items li on li.item_number = setup.item_number
on conflict (linen_item_id) do update set
  qty_per_room = excluded.qty_per_room;

with rules(category, item_number, percentage, use_checklist, notes) as (
  values
    ('checkout_serviced', 1, 100, false, null),
    ('checkout_serviced', 2, 100, false, null),
    ('checkout_serviced', 3, 100, false, null),
    ('checkout_serviced', 4, 100, false, null),
    ('checkout_serviced', 5, 100, false, null),
    ('checkout_serviced', 6, 100, false, null),
    ('checkout_serviced', 7, 50, false, 'ปลอกผ้านวมไม่เปลี่ยนทุกห้อง'),
    ('checkout_serviced', 8, 50, false, 'ปลอกผ้านวมไม่เปลี่ยนทุกห้อง'),
    ('checkout_serviced', 9, 50, false, 'ปลอกผ้านวมไม่เปลี่ยนทุกห้อง'),
    ('checkout_towel_only', 1, 0, false, null),
    ('checkout_towel_only', 2, 100, false, 'FO รวบรวมผ้าขนหนูก่อน cutoff'),
    ('checkout_towel_only', 3, 0, false, null),
    ('checkout_towel_only', 4, 0, false, null),
    ('checkout_towel_only', 5, 0, false, null),
    ('checkout_towel_only', 6, 0, false, null),
    ('checkout_towel_only', 7, 0, false, null),
    ('checkout_towel_only', 8, 0, false, null),
    ('checkout_towel_only', 9, 0, false, null),
    ('inhouse_serviced', 1, 100, false, null),
    ('inhouse_serviced', 2, 0, true, 'ใช้ยอดจาก HK checklist'),
    ('inhouse_serviced', 3, 100, false, null),
    ('inhouse_serviced', 4, 80, false, 'บางห้องไม่เปลี่ยนผ้าปู'),
    ('inhouse_serviced', 5, 80, false, 'บางห้องไม่เปลี่ยนผ้าปู'),
    ('inhouse_serviced', 6, 80, false, 'บางห้องไม่เปลี่ยนผ้าปู'),
    ('inhouse_serviced', 7, 50, false, 'ปลอกผ้านวมไม่เปลี่ยนทุกห้อง'),
    ('inhouse_serviced', 8, 50, false, 'ปลอกผ้านวมไม่เปลี่ยนทุกห้อง'),
    ('inhouse_serviced', 9, 50, false, 'ปลอกผ้านวมไม่เปลี่ยนทุกห้อง'),
    ('inhouse_not_started', 1, 0, false, null),
    ('inhouse_not_started', 2, 0, false, null),
    ('inhouse_not_started', 3, 0, false, null),
    ('inhouse_not_started', 4, 0, false, null),
    ('inhouse_not_started', 5, 0, false, null),
    ('inhouse_not_started', 6, 0, false, null),
    ('inhouse_not_started', 7, 0, false, null),
    ('inhouse_not_started', 8, 0, false, null),
    ('inhouse_not_started', 9, 0, false, null),
    ('inhouse_no_task', 1, 0, false, null),
    ('inhouse_no_task', 2, 0, false, null),
    ('inhouse_no_task', 3, 0, false, null),
    ('inhouse_no_task', 4, 0, false, null),
    ('inhouse_no_task', 5, 0, false, null),
    ('inhouse_no_task', 6, 0, false, null),
    ('inhouse_no_task', 7, 0, false, null),
    ('inhouse_no_task', 8, 0, false, null),
    ('inhouse_no_task', 9, 0, false, null),
    ('inhouse_no_service', 1, 0, false, null),
    ('inhouse_no_service', 2, 0, true, 'ใช้ยอดจาก HK checklist ถ้ามี'),
    ('inhouse_no_service', 3, 0, false, null),
    ('inhouse_no_service', 4, 0, false, null),
    ('inhouse_no_service', 5, 0, false, null),
    ('inhouse_no_service', 6, 0, false, null),
    ('inhouse_no_service', 7, 0, false, null),
    ('inhouse_no_service', 8, 0, false, null),
    ('inhouse_no_service', 9, 0, false, null),
    ('after_cutoff', 1, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 2, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 3, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 4, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 5, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 6, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 7, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 8, 0, false, 'นับเป็นพรุ่งนี้'),
    ('after_cutoff', 9, 0, false, 'นับเป็นพรุ่งนี้')
)
insert into public.linen_usage_rules (category, linen_item_id, percentage, use_checklist, notes)
select rules.category, li.id, rules.percentage, rules.use_checklist, rules.notes
from rules
join public.linen_items li on li.item_number = rules.item_number
where li.is_active = true
on conflict (category, linen_item_id) do update set
  percentage = excluded.percentage,
  use_checklist = excluded.use_checklist,
  notes = excluded.notes;

commit;
