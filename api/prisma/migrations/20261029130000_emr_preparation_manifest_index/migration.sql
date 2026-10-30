-- Both manifest retention and the FK's delete check look up referring preparations.
CREATE INDEX preparation_source_manifest ON emr_image.preparation(source_manifest_body);
