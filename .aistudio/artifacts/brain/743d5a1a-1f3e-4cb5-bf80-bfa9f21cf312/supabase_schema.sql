-- 1. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    uid TEXT UNIQUE NOT NULL, -- Firebase UID or custom ID
    phone TEXT UNIQUE NOT NULL,
    national_id TEXT UNIQUE,
    full_name TEXT,
    trust_score INT DEFAULT 100,
    telegram_id TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'suspended')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Deals Table
CREATE TABLE deals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contract_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    amount DECIMAL NOT NULL,
    terms TEXT,
    deadline_days INT DEFAULT 7,
    creator_id UUID REFERENCES users(id),
    buyer_id UUID REFERENCES users(id),
    seller_id UUID REFERENCES users(id),
    arbitrator_id UUID REFERENCES users(id),
    status TEXT DEFAULT 'pending_signatures' CHECK (status IN ('draft', 'pending_signatures', 'active', 'completed', 'disputed', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Signatures Table (Legal Evidence)
CREATE TABLE signatures (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    deal_id UUID REFERENCES deals(id),
    user_id UUID REFERENCES users(id),
    national_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    otp_verified BOOLEAN DEFAULT TRUE,
    ip_address TEXT,
    metadata JSONB,
    signed_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Disputes Table
CREATE TABLE disputes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    case_id TEXT UNIQUE NOT NULL,
    deal_id UUID REFERENCES deals(id),
    arbitrator_id UUID REFERENCES users(id),
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved')),
    final_verdict TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);

-- 5. Dispute Messages
CREATE TABLE dispute_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    dispute_id UUID REFERENCES disputes(id),
    sender_id UUID REFERENCES users(id),
    content TEXT NOT NULL,
    evidence_urls TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Wallet Transactions
CREATE TABLE wallet_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    amount DECIMAL NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('deposit', 'withdrawal', 'escrow_hold', 'escrow_release')),
    deal_id UUID REFERENCES deals(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
