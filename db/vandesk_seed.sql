-- =============================================================================================
-- VanDesk seed data. Run AFTER db/vandesk_schema.sql, once, on the same database.
--
--   1. Change the three values below (admin email and name, and whether to load the demo data).
--   2. Run the whole file (Neon SQL editor, psql -f, any client).
--
-- Safe to run again: an admin that already exists and a database that already has vehicles are left alone.
-- Sign-in is by email code, so the admin email must be one you can read (in development the code is shown on the sign-in screen).
-- =============================================================================================
DO $$
DECLARE
	-- >>>>>>>>>> EDIT THESE <<<<<<<<<<
	admin_email TEXT    := 'admin@vandesk.test';
	admin_name  TEXT    := 'VanDesk Admin';
	load_demo   BOOLEAN := TRUE;      -- TRUE = also create 2 buses, 2 drivers, 6 parents, 7 students, fees and a few payments
	-- >>>>>>>>>>>>>>>>><<<<<<<<<<<<<<<

	r        RECORD;
	new_uid  BIGINT;
	pay_id   BIGINT;
	left_amt INT;
	take_amt INT;
	cur_month DATE := DATE_TRUNC('month', NOW() AT TIME ZONE 'Asia/Kolkata')::DATE;
BEGIN
	-- ------------------------------------------------------------------ admin
	IF EXISTS (SELECT 1 FROM users WHERE LOWER(email) = LOWER(admin_email)) THEN
		RAISE NOTICE 'Admin % already exists, left as it is', admin_email;
	ELSE
		INSERT INTO users(email, is_verified) VALUES (LOWER(TRIM(admin_email)), TRUE) RETURNING id INTO new_uid;
		INSERT INTO user_profile(user_id, name) VALUES (new_uid, admin_name);
		INSERT INTO user_roles(user_id, role_id) SELECT new_uid, id FROM roles WHERE name = 'admin';
		RAISE NOTICE 'Admin % created', admin_email;
	END IF;

	IF NOT load_demo THEN
		RETURN;
	END IF;
	IF EXISTS (SELECT 1 FROM vehicles) THEN
		RAISE NOTICE 'Demo data skipped: the database already has vehicles';
		RETURN;
	END IF;

	-- ------------------------------------------------------------ drivers and parents
	FOR r IN
		SELECT * FROM (VALUES
			('ramesh@vandesk.test',   'Ramesh Kale',   'driver', '9820000001'),
			('suresh@vandesk.test',   'Suresh Wagh',   'driver', '9820000002'),
			('mrpatil@mail.test',     'Mr. Patil',     'parent', '9820000100'),
			('mrsjoshi@mail.test',    'Mrs. Joshi',    'parent', '9820000101'),
			('mrskulkarni@mail.test', 'Mrs. Kulkarni', 'parent', '9820000102'),
			('mrsmore@mail.test',     'Mrs. More',     'parent', '9820000103'),
			('mrsnaik@mail.test',     'Mrs. Naik',     'parent', '9820000104'),
			('mrsinha@mail.test',     'Mr. Sinha',     'parent', '9820000105')
		) AS t(email, nm, role_name, phone)
	LOOP
		INSERT INTO users(email, phone, is_verified) VALUES (r.email, r.phone, TRUE) RETURNING id INTO new_uid;
		INSERT INTO user_profile(user_id, name) VALUES (new_uid, r.nm);
		INSERT INTO user_roles(user_id, role_id) SELECT new_uid, id FROM roles WHERE name = r.role_name;
	END LOOP;

	-- ------------------------------------------------------------ vehicles, stops, fee plans
	INSERT INTO vehicles(name, reg_no, capacity, driver_id)
	SELECT v.nm, v.reg, v.cap, u.id
	FROM (VALUES ('Van', 'MH-20 AB 1234', 6, 'ramesh@vandesk.test'), ('Mini bus', 'MH-20 CD 5678', 14, 'suresh@vandesk.test')) AS v(nm, reg, cap, driver_email)
	JOIN users u ON LOWER(u.email) = v.driver_email;

	INSERT INTO stops(vehicle_id, name, seq, typical_time)
	SELECT v.id, s.nm, s.seq, s.tm::TIME
	FROM (VALUES
		('MH-20 AB 1234', 'Hanuman Mandir', 1, '07:05'),
		('MH-20 AB 1234', 'Ganpati Mandir', 2, '07:15'),
		('MH-20 AB 1234', 'Garden Chowk',   3, '07:25'),
		('MH-20 AB 1234', 'Bus Stand',      4, '07:35'),
		('MH-20 CD 5678', 'Station Road',   1, '07:10'),
		('MH-20 CD 5678', 'Market Yard',    2, '07:25')
	) AS s(reg, nm, seq, tm)
	JOIN vehicles v ON v.reg_no = s.reg;

	INSERT INTO fee_plans(vehicle_id, amount, effective_from) SELECT id, 30000, DATE '2026-06-01' FROM vehicles;   -- Rs 300 per month

	-- ------------------------------------------------------------ students
	INSERT INTO students(name, class_name, vehicle_id, stop_id, guardian_id, joined_on)
	SELECT k.nm, k.cls, v.id, st.id, g.id, k.joined::DATE
	FROM (VALUES
		('Akshay Patil',    '5', 'MH-20 AB 1234', 'Hanuman Mandir', 'mrpatil@mail.test',     '2026-06-01'),
		('Ishita Patil',    '3', 'MH-20 AB 1234', 'Hanuman Mandir', 'mrpatil@mail.test',     '2026-06-01'),
		('Karthik Joshi',   '6', 'MH-20 AB 1234', 'Ganpati Mandir', 'mrsjoshi@mail.test',    '2026-06-01'),
		('Harsha Kulkarni', '7', 'MH-20 AB 1234', 'Garden Chowk',   'mrskulkarni@mail.test', '2026-08-01'),
		('Rohan More',      '8', 'MH-20 AB 1234', 'Garden Chowk',   'mrsmore@mail.test',     '2026-06-01'),
		('Diya Naik',       '4', 'MH-20 CD 5678', 'Station Road',   'mrsnaik@mail.test',     '2026-06-01'),
		('Kabir Sinha',     '6', 'MH-20 CD 5678', 'Market Yard',    'mrsinha@mail.test',     '2026-07-01')
	) AS k(nm, cls, reg, stop_nm, guardian_email, joined)
	JOIN vehicles v ON v.reg_no = k.reg
	JOIN stops st   ON st.vehicle_id = v.id AND st.name = k.stop_nm
	JOIN users g    ON LOWER(g.email) = k.guardian_email;

	-- ------------------------------------------------------------ monthly dues, June 2026 up to this month
	INSERT INTO fee_dues(student_id, due_month, amount)
	SELECT s.id, m.d, p.amount
	FROM students s
	CROSS JOIN (SELECT g::DATE AS d FROM GENERATE_SERIES(DATE '2026-06-01', cur_month, INTERVAL '1 month') AS g) m
	JOIN LATERAL (SELECT amount FROM fee_plans WHERE vehicle_id = s.vehicle_id AND effective_from <= m.d ORDER BY effective_from DESC LIMIT 1) p ON TRUE
	WHERE s.joined_on <= m.d;

	-- ------------------------------------------------------------ a few cash payments, applied to the oldest dues first
	FOR r IN
		SELECT * FROM (VALUES
			('Akshay Patil', 150000), ('Ishita Patil', 60000), ('Karthik Joshi', 90000), ('Harsha Kulkarni', 30000), ('Diya Naik', 120000)
		) AS t(student_name, amt)
	LOOP
		INSERT INTO payments(student_id, kind, amount, mode, paid_on, recorded_by)
		SELECT s.id, (SELECT id FROM enum_master WHERE master_name = 'payment_kind' AND option_name = 'payment'), r.amt,
		       (SELECT id FROM enum_master WHERE master_name = 'payment_mode' AND option_name = 'cash'), DATE '2026-09-12',
		       (SELECT id FROM users WHERE LOWER(email) = 'ramesh@vandesk.test')
		FROM students s WHERE s.name = r.student_name
		RETURNING id INTO pay_id;

		left_amt := r.amt;
		FOR new_uid, take_amt IN
			SELECT d.id, d.amount FROM fee_dues d JOIN students s ON s.id = d.student_id WHERE s.name = r.student_name ORDER BY d.due_month
		LOOP
			EXIT WHEN left_amt <= 0;
			INSERT INTO payment_allocations(payment_id, due_id, amount) VALUES (pay_id, new_uid, LEAST(left_amt, take_amt));
			left_amt := left_amt - LEAST(left_amt, take_amt);
		END LOOP;
	END LOOP;

	RAISE NOTICE 'Demo data loaded';
END $$;
