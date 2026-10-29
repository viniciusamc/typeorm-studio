const failure = new Error(
  `cannot reach ${process.env.CASE_API_TOKEN} through postgres://app_user:case-url-password-3319@db.example.test:5432/app\nsecond line with CASE_SECOND_LINE_MARKER`,
);
failure.code = 'E_CASE_FAILURE';
throw failure;
