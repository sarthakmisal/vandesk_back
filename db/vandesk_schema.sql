
-- VanDesk | PostgreSQL schema (same conventions as the Resello script)
--   * BIGSERIAL ids, snake_case, plural table names
--   * every status/kind/mode column is an INT whose meaning lives in enum_master (see the trailing comment on each column)
--   * money is integer PAISE (Rs 300 = 30000), never floats
--   * business dates are DATE (Asia/Kolkata), instants are TIMESTAMPTZ (stored UTC)
-- Run once on an empty database:  psql "$DATABASE_URL" -f db/vandesk_schema.sql   (or: npm run db:migrate)

BEGIN;
	CREATE TABLE enum_master(
		id BIGINT NOT NULL,
		master_name VARCHAR(50) NOT NULL,
		option_name VARCHAR(50) NOT NULL,
		sort_index INT NOT NULL DEFAULT 1,
		is_active BOOLEAN DEFAULT TRUE,
		UNIQUE(master_name, option_name),
		UNIQUE(master_name, id)
	);

	-- ---------------------------------------------------------------- auth
	CREATE TABLE users (
		id BIGSERIAL PRIMARY KEY,
		email VARCHAR(150) NOT NULL,
		phone VARCHAR(15),
		status INT NOT NULL DEFAULT 1,   -- user_status | active suspended deleted
		is_verified BOOLEAN DEFAULT FALSE,
		last_login_at TIMESTAMPTZ,
		created_at TIMESTAMPTZ DEFAULT NOW(),
		updated_at TIMESTAMPTZ DEFAULT NOW()
	);
	CREATE UNIQUE INDEX uq_users_email ON users (LOWER(email));

	CREATE TABLE user_profile(
		user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		name VARCHAR(100) NOT NULL,
		avatar_url TEXT,
		created_at TIMESTAMPTZ DEFAULT NOW(),
		updated_at TIMESTAMPTZ DEFAULT NOW()
	);

	CREATE TABLE roles(
		id SERIAL PRIMARY KEY,
		name VARCHAR(50) NOT NULL UNIQUE,   -- admin | driver | parent
		description TEXT,
		is_system BOOLEAN DEFAULT FALSE
	);

	CREATE TABLE user_roles(
		user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
		role_id INT REFERENCES roles(id) ON DELETE CASCADE,
		PRIMARY KEY (user_id, role_id)
	);

	-- Email sign-in codes (6 digits, hashed, 5 minutes, max 5 wrong tries)
	CREATE TABLE auth_otp(
		id BIGSERIAL PRIMARY KEY,
		email VARCHAR(150) NOT NULL,
		otp_hash TEXT NOT NULL,
		attempts INT NOT NULL DEFAULT 0,
		is_used BOOLEAN NOT NULL DEFAULT FALSE,
		expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	-- ------------------------------------------------------- vehicles & route
	CREATE TABLE vehicles(
		id BIGSERIAL PRIMARY KEY,
		name VARCHAR(30) NOT NULL,                 -- "Van", "Mini bus"
		reg_no VARCHAR(20) NOT NULL UNIQUE,        -- "MH-20 AB 1234"
		capacity INT NOT NULL CHECK (capacity > 0),
		driver_id BIGINT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
		status INT NOT NULL DEFAULT 1,             -- vehicle_status | active inactive
		created_at TIMESTAMPTZ DEFAULT NOW(),
		updated_at TIMESTAMPTZ DEFAULT NOW()
	);

	CREATE TABLE stops(
		id BIGSERIAL PRIMARY KEY,
		vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
		name VARCHAR(80) NOT NULL,
		seq INT NOT NULL,                          -- 1 = first stop of the morning run
		typical_time TIME,                         -- usual pickup time, shown to parents
		UNIQUE (vehicle_id, seq)
	);

	-- ------------------------------------------------------------- students
	CREATE TABLE students(
		id BIGSERIAL PRIMARY KEY,
		name VARCHAR(100) NOT NULL,
		class_name VARCHAR(20) NOT NULL DEFAULT '',
		vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE RESTRICT,
		stop_id BIGINT REFERENCES stops(id) ON DELETE SET NULL,
		guardian_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
		status INT NOT NULL DEFAULT 1,             -- student_status | active paused left
		joined_on DATE NOT NULL,                   -- first day of the joining month (a full month is charged)
		created_at TIMESTAMPTZ DEFAULT NOW(),
		updated_at TIMESTAMPTZ DEFAULT NOW()
	);
	CREATE UNIQUE INDEX uq_students_guardian_name ON students (guardian_id, LOWER(name));

	-- ----------------------------------------------------------------- fees
	CREATE TABLE fee_plans(
		id BIGSERIAL PRIMARY KEY,
		vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
		amount INT NOT NULL CHECK (amount >= 0),   -- paise per month
		effective_from DATE NOT NULL,
		created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
		created_at TIMESTAMPTZ DEFAULT NOW(),
		UNIQUE (vehicle_id, effective_from)
	);

	CREATE TABLE fee_dues(
		id BIGSERIAL PRIMARY KEY,
		student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
		due_month DATE NOT NULL CHECK (due_month = DATE_TRUNC('month', due_month)::DATE),
		amount INT NOT NULL CHECK (amount >= 0),   -- paise, fixed when the due is generated
		created_at TIMESTAMPTZ DEFAULT NOW(),
		UNIQUE (student_id, due_month)
	);

	-- Payments are append-only: a mistake is a reversal row, the original is never edited or deleted
	CREATE TABLE payments(
		id BIGSERIAL PRIMARY KEY,
		student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
		kind INT NOT NULL DEFAULT 1,               -- payment_kind | payment reversal
		amount INT NOT NULL CHECK (amount > 0),    -- paise
		mode INT NOT NULL DEFAULT 1,               -- payment_mode | cash upi other
		paid_on DATE NOT NULL,
		recorded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
		reversal_of BIGINT UNIQUE REFERENCES payments(id) ON DELETE RESTRICT, -- UNIQUE: a payment is reversed at most once
		note TEXT,
		client_uuid UUID UNIQUE,                   -- sent by the app so a retry on a bad network never records twice
		created_at TIMESTAMPTZ DEFAULT NOW(),
		CHECK ((kind = 2) = (reversal_of IS NOT NULL))
	);

	-- Which payment paid which month (oldest due first). A reversal writes the same rows with a negative amount.
	CREATE TABLE payment_allocations(
		id BIGSERIAL PRIMARY KEY,
		payment_id BIGINT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
		due_id BIGINT NOT NULL REFERENCES fee_dues(id) ON DELETE RESTRICT,
		amount INT NOT NULL CHECK (amount <> 0),
		created_at TIMESTAMPTZ DEFAULT NOW()
	);

	-- ---------------------------------------------------------------- trips
	CREATE TABLE trips(
		id BIGSERIAL PRIMARY KEY,
		vehicle_id BIGINT NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
		trip_date DATE NOT NULL,
		direction INT NOT NULL,                    -- trip_direction | pickup drop
		status INT NOT NULL DEFAULT 1,             -- trip_status | started ended   (no row yet = idle)
		started_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
		started_at TIMESTAMPTZ,
		ended_at TIMESTAMPTZ,
		UNIQUE (vehicle_id, trip_date, direction)
	);

	-- One row per student per trip. Location is captured only at the tap, never in the background.
	CREATE TABLE trip_events(
		id BIGSERIAL PRIMARY KEY,
		trip_id BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
		student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
		kind INT NOT NULL,                         -- trip_event_kind | boarded skipped
		event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		lat DOUBLE PRECISION,
		lng DOUBLE PRECISION,
		accuracy REAL,                             -- metres
		flag INT,                                  -- location_flag | no_fix low_accuracy
		UNIQUE (trip_id, student_id)
	);

	-- Parent's "going / not going" for a day (default = going when no row)
	CREATE TABLE attendance_intents(
		student_id BIGINT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
		trip_date DATE NOT NULL,
		direction INT NOT NULL,                    -- trip_direction | pickup drop
		going BOOLEAN NOT NULL,
		is_late BOOLEAN NOT NULL DEFAULT FALSE,    -- changed after the cutoff, driver sees a badge
		set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		PRIMARY KEY (student_id, trip_date, direction)
	);

	-- ------------------------------------------------------------- messaging
	CREATE TABLE notifications(
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
		student_id BIGINT REFERENCES students(id) ON DELETE SET NULL,
		channel INT NOT NULL DEFAULT 1,            -- notification_channel | email
		template INT NOT NULL,                     -- notification_template | receipt reminder invite
		dedupe_key VARCHAR(100) NOT NULL UNIQUE,   -- the same key is never sent twice
		subject TEXT,
		body TEXT,
		status INT NOT NULL DEFAULT 1,             -- notification_status | queued sent failed
		attempts INT NOT NULL DEFAULT 0,
		error TEXT,
		queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		sent_at TIMESTAMPTZ
	);

	CREATE TABLE audit_logs(
		id BIGSERIAL PRIMARY KEY,
		actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
		action VARCHAR(50) NOT NULL,
		entity VARCHAR(50),
		entity_id BIGINT,
		detail TEXT,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	-- ---------------------------------------------------------------- views
	-- What is still unpaid for every month
	CREATE VIEW fee_due_balances AS
		SELECT d.id, d.student_id, d.due_month, d.amount,
			(d.amount - COALESCE(SUM(a.amount), 0))::INT AS outstanding
		FROM fee_dues d
		LEFT JOIN payment_allocations a ON a.due_id = d.id
		GROUP BY d.id;

	-- Money received but not yet matched to a month (advance payment)
	CREATE VIEW student_credits AS
		SELECT s.id AS student_id,
			(COALESCE((SELECT SUM(CASE WHEN p.kind = 1 THEN p.amount ELSE -p.amount END) FROM payments p WHERE p.student_id = s.id), 0)
			- COALESCE((SELECT SUM(a.amount) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.student_id = s.id), 0))::INT AS credit
		FROM students s;

	-- ---------------------------------------------------------------- indexes
	CREATE INDEX idx_students_vehicle ON students(vehicle_id) WHERE status <> 3;
	CREATE INDEX idx_students_guardian ON students(guardian_id);
	CREATE INDEX idx_stops_vehicle ON stops(vehicle_id, seq);
	CREATE INDEX idx_alloc_due ON payment_allocations(due_id);
	CREATE INDEX idx_alloc_payment ON payment_allocations(payment_id);
	CREATE INDEX idx_payments_student ON payments(student_id, created_at DESC);
	CREATE INDEX idx_payments_paid_on ON payments(paid_on);
	CREATE INDEX idx_trips_day ON trips(trip_date, vehicle_id);
	CREATE INDEX idx_trip_events_at ON trip_events(event_at) WHERE lat IS NOT NULL;
	CREATE INDEX idx_otp_email ON auth_otp(email, created_at DESC);

	-- ------------------------------------------------------------ enum_master
	CREATE OR REPLACE FUNCTION enum_master_id()
	RETURNS TRIGGER
	LANGUAGE plpgsql AS $$
	DECLARE max_id INT;
	BEGIN
		SELECT COALESCE(MAX(id),0) + 1
			INTO max_id
			FROM enum_master
			WHERE master_name = NEW.master_name;

			NEW.id = max_id;
			NEW.sort_index= max_id;
			RETURN NEW;
	END;
	$$;

	CREATE TRIGGER trg_enum_sort_index
	BEFORE INSERT ON enum_master
	FOR EACH ROW
	EXECUTE FUNCTION enum_master_id();

	-- ids are assigned 1,2,3... per master_name in the order written below. src/enums.js mirrors them (npm test checks it).
	INSERT INTO enum_master(master_name, option_name) VALUES
		('user_status', 'active'), ('user_status', 'suspended'), ('user_status', 'deleted'),
		('vehicle_status', 'active'), ('vehicle_status', 'inactive'),
		('student_status', 'active'), ('student_status', 'paused'), ('student_status', 'left'),
		('trip_direction', 'pickup'), ('trip_direction', 'drop'),
		('trip_status', 'started'), ('trip_status', 'ended'),
		('trip_event_kind', 'boarded'), ('trip_event_kind', 'skipped'),
		('location_flag', 'no_fix'), ('location_flag', 'low_accuracy'),
		('payment_kind', 'payment'), ('payment_kind', 'reversal'),
		('payment_mode', 'cash'), ('payment_mode', 'upi'), ('payment_mode', 'other'),
		('notification_channel', 'email'),
		('notification_template', 'receipt'), ('notification_template', 'reminder'), ('notification_template', 'invite'),
		('notification_status', 'queued'), ('notification_status', 'sent'), ('notification_status', 'failed');

	INSERT INTO roles(name, description, is_system) VALUES
		('admin', 'VanDesk team: buses, drivers, stops, fees and student placement', TRUE),
		('driver', 'Runs one vehicle: trips, students, fees', TRUE),
		('parent', 'Follows own children: tracking, going/not going, fee statement', TRUE);
COMMIT;
