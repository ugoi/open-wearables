import os
import tempfile
from logging import getLogger
from pathlib import Path

from celery import shared_task
from sqlalchemy import text

from app.database import SessionLocal
from app.services import event_record_service
from app.services.apple.apple_xml.aws_service import get_s3_client
from app.services.apple.apple_xml.xml_service import XMLService
from app.services.apple.healthkit.sleep_service import handle_sleep_data
from app.services.import_progress_service import update_progress
from app.services.outgoing_webhooks.svix import suppress_webhooks
from app.services.timeseries_service import timeseries_service
from app.services.user_service import user_service
from app.utils.exceptions import ResourceNotFoundError
from app.utils.sentry_helpers import log_and_capture_error

logger = getLogger(__name__)


@shared_task(bind=True)
def process_aws_upload(self, bucket_name: str, object_key: str, user_id: str) -> dict[str, str]:
    """Process XML file uploaded to S3 and import to Postgres database."""

    task_id = self.request.id

    s3_client = get_s3_client()
    if not s3_client:
        err = RuntimeError("S3 client not configured — cannot process AWS upload")
        log_and_capture_error(
            err,
            logger,
            "S3 client unavailable in process_aws_upload task",
            extra={"bucket_name": bucket_name, "object_key": object_key, "user_id": user_id},
        )
        update_progress(task_id, user_id, phase="error", percent=0, message="S3 client not configured")
        raise err

    db = SessionLocal()
    temp_xml_file = None

    try:
        temp_dir = tempfile.gettempdir()
        temp_xml_file = os.path.join(temp_dir, f"temp_import_{object_key.split('/')[-1]}")

        try:
            _ = user_service.get(db, user_id, raise_404=True)
        except ResourceNotFoundError as e:
            log_and_capture_error(
                e,
                logger,
                "Skipping import for non-existent user",
                extra={"user_id": user_id},
            )
            update_progress(task_id, user_id, phase="error", percent=0, message="User not found")
            return {"status": "skipped", "reason": str(e)}

        update_progress(task_id, user_id, phase="downloading", percent=5, message="Downloading file from storage")
        s3_client.download_file(bucket_name, object_key, temp_xml_file)

        file_size = os.path.getsize(temp_xml_file)
        update_progress(task_id, user_id, phase="processing", percent=10, message="Starting XML parsing")

        try:
            _import_xml_data(temp_xml_file, user_id, task_id, file_size)
        except Exception as e:
            update_progress(task_id, user_id, phase="error", percent=0, message=str(e)[:200])
            raise e

        update_progress(task_id, user_id, phase="complete", percent=100, message="Import completed successfully")

        return {
            "bucket": bucket_name,
            "input_key": object_key,
            "user_id": user_id,
            "status": "success",
            "message": "Import completed successfully",
        }

    finally:
        if temp_xml_file and os.path.exists(temp_xml_file):
            os.remove(temp_xml_file)
        db.close()


def _import_xml_data(xml_path: str, user_id: str, task_id: str, file_size: int) -> None:
    """Parse XML file and import data to database."""
    suppress_webhooks(True)
    try:
        _do_import(xml_path, user_id, task_id, file_size)
    finally:
        suppress_webhooks(False)


def _do_import(xml_path: str, user_id: str, task_id: str, file_size: int) -> None:
    xml_service = XMLService(Path(xml_path), getLogger(__name__))

    # Estimate total chunks from file size (~100 bytes per record avg, chunk_size=50000)
    bytes_per_chunk = xml_service.chunk_size * 100
    estimated_chunks = max(1, file_size // bytes_per_chunk)
    chunk_num = 0
    total_records = 0

    for time_series_records, workouts, sync_request in xml_service.parse_xml(user_id):
        if workouts:
            for record, detail in workouts:
                workout_db = SessionLocal()
                try:
                    created_record = event_record_service.create(workout_db, record)
                    detail_for_record = detail.model_copy(update={"record_id": created_record.id})
                    event_record_service.create_detail(workout_db, detail_for_record)
                    workout_db.commit()
                except Exception as e:
                    logger.warning("Failed to save workout record: %s - skipping", e)
                finally:
                    workout_db.close()

        if time_series_records:
            ts_db = SessionLocal()
            try:
                ts_db.execute(text("SET LOCAL synchronous_commit = off"))
                timeseries_service.bulk_create_samples(ts_db, time_series_records)
                ts_db.commit()
            finally:
                ts_db.close()

        if sync_request and sync_request.data.sleep:
            sleep_db = SessionLocal()
            try:
                handle_sleep_data(sleep_db, sync_request, user_id)
                sleep_db.commit()
            finally:
                sleep_db.close()

        chunk_num += 1
        chunk_records = len(time_series_records) + len(workouts)
        if sync_request and sync_request.data.sleep:
            chunk_records += len(sync_request.data.sleep)
        total_records += chunk_records

        # Progress: 10-95% range for processing (5% download, 5% finalize)
        progress = 10 + int(85 * min(chunk_num / estimated_chunks, 1.0))
        update_progress(
            task_id,
            user_id,
            phase="processing",
            percent=min(progress, 95),
            chunks_done=chunk_num,
            records_processed=total_records,
            message=f"Processed {total_records:,} records",
        )
