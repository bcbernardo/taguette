"""edugain : fix field type

Revision ID: fbdc29566f62
Revises: e459991d960e
Create Date: 2024-03-26 11:25:38.289515

"""
from alembic import op
import sqlalchemy as sa
import logging

logger = logging.getLogger(__name__)

# revision identifiers, used by Alembic.
revision = 'fbdc29566f62'
down_revision = 'e459991d960e'
branch_labels = None
depends_on = None


def upgrade():
    db_url = op.get_context().config.get_section('alembic')['sqlalchemy.url']
    if db_url.startswith('sqlite:'):
        # SQLite doesn't mind field length
        logger.info(f"Skipping upgrade {revision} for SQLite")
    else:
        op.alter_column('edigainidps', 'scopes',
                        existing_type=sa.VARCHAR(length=255),
                        type_=sa.Text(),
                        existing_nullable=True)


def downgrade():
    db_url = op.get_context().config.get_section('alembic')['sqlalchemy.url']
    if db_url.startswith('sqlite:'):
        # SQLite doesn't mind field length
        logger.info(f"Skipping downgrade {down_revision} for SQLite")
    else:
        op.alter_column('edigainidps', 'scopes',
                        existing_type=sa.Text(),
                        type_=sa.VARCHAR(length=255),
                        existing_nullable=True)
