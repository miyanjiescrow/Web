-- 1. Contract Live Chat System
CREATE TABLE IF NOT EXISTS public.contract_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id VARCHAR(32) REFERENCES public.contracts(contract_id) ON DELETE CASCADE,
    sender_id BIGINT REFERENCES public.users(id),
    message_text TEXT NOT NULL,
    attachment_url TEXT NULL,
    is_system BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Realtime for Chat
-- Note: Check if the publication exists first in Supabase UI, or run:
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.contract_messages;

-- 2. User Notifications System
CREATE TABLE IF NOT EXISTS public.notifications (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id),
    title VARCHAR(200) NOT NULL,
    body TEXT NOT NULL,
    link TEXT NULL,
    is_read BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable Realtime for Notifications
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- 3. Support Tickets System
CREATE TABLE IF NOT EXISTS public.support_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id BIGINT REFERENCES public.users(id),
    subject VARCHAR(200) NOT NULL,
    status TEXT DEFAULT 'open' CHECK (status IN ('open', 'replied', 'closed')),
    priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID REFERENCES public.support_tickets(id) ON DELETE CASCADE,
    sender_id BIGINT REFERENCES public.users(id), 
    message_text TEXT NOT NULL,
    is_admin_reply BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Functions to handle updated_at
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_support_tickets_modtime
    BEFORE UPDATE ON public.support_tickets
    FOR EACH ROW
    EXECUTE PROCEDURE update_modified_column();

-- 4. User Contacts and Relationships
CREATE TABLE IF NOT EXISTS public.user_contacts (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE,
    contact_user_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE,
    nickname VARCHAR(100),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, contact_user_id)
);

-- 5. User Reports / Flagging
CREATE TABLE IF NOT EXISTS public.user_reports (
    id BIGSERIAL PRIMARY KEY,
    reporter_id BIGINT REFERENCES public.users(id),
    reported_id BIGINT REFERENCES public.users(id),
    reason TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
