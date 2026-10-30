/*
 * kin_sof3: the smallest decode entry the viewer hook needs, over unmodified libjpeg-turbo 3.x.
 * Decodes one single-component JPEG codestream (lossless SOF3 at 2-16 bits, which is what DICOM .70/.57 carry; the
 * 8/12-bit lossy processes come for free) into 16-bit little-endian samples. libjpeg's error path cannot longjmp in a
 * plain wasm32 build, so error_exit hands the message to the host (kin_fail), which throws; the host then discards this
 * instance, because libjpeg's allocator state is undefined after an error. Warnings are counted, not printed.
 */
#include <stdio.h>   /* jpeglib.h declares the stdio source/destination managers against FILE */
#include <stdlib.h>
#include <string.h>
#include "jpeglib.h"
#include "jerror.h"

__attribute__((import_module("env"), import_name("kin_fail"))) void kin_fail(const char *message, int length);

static char last_message[JMSG_LENGTH_MAX];
static int warnings;

static void error_exit(j_common_ptr cinfo) {
  (*cinfo->err->format_message)(cinfo, last_message);
  kin_fail(last_message, (int)strlen(last_message));
  abort();
}

static void emit_message(j_common_ptr cinfo, int msg_level) {
  if (msg_level < 0) warnings++;
}

__attribute__((export_name("kin_alloc"))) void *kin_alloc(size_t n) { return malloc(n); }
__attribute__((export_name("kin_free"))) void kin_free(void *p) { free(p); }
__attribute__((export_name("kin_warnings"))) int kin_warnings(void) { return warnings; }

/*
 * info[0..3] = width, height, components, sample precision (after the header). Returns the precision on success,
 * -1 if the stream is not single-component, -2 if dst is too small (dst_samples counts 16-bit samples).
 */
__attribute__((export_name("kin_decode16"))) int kin_decode16(const unsigned char *src, size_t src_len,
                                                               unsigned short *dst, size_t dst_samples, int *info) {
  struct jpeg_decompress_struct cinfo;
  struct jpeg_error_mgr jerr;
  warnings = 0;
  cinfo.err = jpeg_std_error(&jerr);
  jerr.error_exit = error_exit;
  jerr.emit_message = emit_message;
  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, src, (unsigned long)src_len);
  jpeg_read_header(&cinfo, TRUE);
  info[0] = (int)cinfo.image_width;
  info[1] = (int)cinfo.image_height;
  info[2] = cinfo.num_components;
  info[3] = cinfo.data_precision;
  if (cinfo.num_components != 1) { jpeg_destroy_decompress(&cinfo); return -1; }
  if ((size_t)cinfo.image_width * cinfo.image_height > dst_samples) { jpeg_destroy_decompress(&cinfo); return -2; }
  cinfo.out_color_space = JCS_GRAYSCALE;
  jpeg_start_decompress(&cinfo);
  const size_t stride = cinfo.output_width;
  const int precision = cinfo.data_precision;
  if (precision <= 8) {
    JSAMPLE *row = (JSAMPLE *)malloc(stride);
    while (cinfo.output_scanline < cinfo.output_height) {
      unsigned short *out = dst + (size_t)cinfo.output_scanline * stride;
      JSAMPROW rows[1] = { row };
      jpeg_read_scanlines(&cinfo, rows, 1);
      for (size_t x = 0; x < stride; x++) out[x] = row[x];
    }
    free(row);
  } else if (precision <= 12) {
    while (cinfo.output_scanline < cinfo.output_height) {
      J12SAMPROW rows[1] = { (J12SAMPROW)(dst + (size_t)cinfo.output_scanline * stride) };
      jpeg12_read_scanlines(&cinfo, rows, 1);
    }
  } else {
    while (cinfo.output_scanline < cinfo.output_height) {
      J16SAMPROW rows[1] = { (J16SAMPROW)(dst + (size_t)cinfo.output_scanline * stride) };
      jpeg16_read_scanlines(&cinfo, rows, 1);
    }
  }
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  return precision;
}
