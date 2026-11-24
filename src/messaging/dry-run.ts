// Dry run, enforced where messages leave the machine.
//
// In dry-run mode the shared sender writes what it would have sent to a file and never calls the
// adapter. That is not enough on its own: an adapter can also send by itself (WhatsApp delivers
// waiting texts when a person writes, and sends template messages). So each adapter's own client
// (the one place its raw requests go through) is told about dry run and refuses to post anything
// that sends: a message, a reaction, a template. Reads (health checks, polling) still go out.

export const DRY_RUN_DETAIL = "dry run: nothing was sent";
